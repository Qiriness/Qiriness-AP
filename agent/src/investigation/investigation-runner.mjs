import { ratchetLevel } from '../../../scripts/lib/support-taxonomy.mjs';
import { supabaseUpsert } from '../../../scripts/lib/supabase-rest-client.mjs';
import { COLUMNS, T } from '../../../scripts/lib/tables.mjs';
import { attemptsSoFar } from '../../../scripts/lib/ticket-record.mjs';

import { emptySenderDirectory } from '../ingestion/sender-directory.mjs';

import { TICKET_STATUS_BY_VERDICT } from './case-file.mjs';
import { summariseNeeds } from './evidence-rules.mjs';
import { ENABLED_SUBJECTS, isInvestigable } from './investigation-rules.mjs';
import { summarisePhotoEvidence } from './photo-evidence.mjs';

// The batch pass that investigates categorised tickets, mirroring
// `categorise-runner.mjs` in every structural respect — because the problems are
// the same ones: a queue that must be catch-up-safe, a model call that can fail,
// and a fallback that has to land in front of a human rather than nowhere.
//
// THE TRIGGER IS THE CATEGORISER FINISHING. It sets `needs_investigation` in the
// same patch that clears `needs_categorisation`, and this pass drains that queue
// later in the same poll. Ingestion does NOT raise the flag itself: a new inbound
// message raises `needs_categorisation`, the categoriser re-labels the thread and
// then re-raises this one. One writer, and no window in which a ticket is
// investigated against labels that describe an older conversation.
//
// Out-of-scope subjects (see ENABLED_SUBJECTS) are skipped and their flag is
// CLEARED — the same reasoning as the categoriser's "thread with no customer
// message": leaving them pending parks them at the front of an oldest-first
// batch for good. Enabling a subject later therefore means re-raising the flag
// for its existing tickets (one update), not just editing the array.

const DEFAULT_BATCH_LIMIT = 10;
const MAX_ATTEMPTS = 3;
const MESSAGES_PER_TICKET = 10;
const MAX_TEXT_CHARS = 4000;

export async function runInvestigation({
  // The case-file store owns `ticket_investigations` and nothing else; the
  // ticket record owns the row this pass moves through the queue. They were one
  // object before, which is how a ticket patch ended up being written here, in
  // the categoriser, and in six other places.
  store,
  record,
  investigate,
  shopId,
  logger,
  limit = DEFAULT_BATCH_LIMIT,
  dryRun = false,
  // Widens the queue to threads the ticket queue has moved past — closed ones.
  // A person typing `--include-closed`, never the worker: see `record.claim`.
  anyStatus = false,
  onResult,
  // Loaded once per poll by the caller and shared across tickets: it is a small
  // map, and rebuilding it per ticket would turn a lookup back into a query.
  senderDirectory = emptySenderDirectory,
  // Which recurring situation this ticket is. OPTIONAL, and absent by default so
  // that a caller which has not wired it runs exactly as it did before.
  //
  // REPORTED, NOT ENFORCED. Its result reaches the stored row and nothing else:
  // it is not passed to `investigate`, so no tool choice, need or verdict can
  // depend on it. That is the whole point — the exemplar's declared
  // `requirement_needs` is only worth comparing against the run's own
  // `evidence_gaps` while the two are arrived at independently.
  retrieveExemplar = null
} = {}) {
  const counts = {
    considered: 0,
    answerable: 0,
    needs_customer_input: 0,
    needs_human: 0,
    skipped: 0,
    failed: 0
  };

  const pending = await record.claim('investigation', { limit, anyStatus });
  counts.considered = pending.length;

  for (const ticket of pending) {
    if (!isInvestigable(ticket)) {
      // Not a failure: the order family has no synced data to investigate yet,
      // and cosmetovigilance / legal_privacy are deliberately left to a person.
      if (!dryRun) {
        await record.skip('investigation', ticket.id);
      }
      counts.skipped += 1;
      continue;
    }

    const messages = await record.inboundMessages(ticket.id, {
      limit: MESSAGES_PER_TICKET,
      columns: COLUMNS.messageForInvestigation
    });
    if (messages.length === 0) {
      if (!dryRun) {
        await record.skip('investigation', ticket.id);
      }
      counts.skipped += 1;
      continue;
    }

    // WHO SENT IT DOES NOT GATE THE INVESTIGATION. A skip on non-demand senders
    // was added here and removed the same day: every one of the 14 threads it
    // would have skipped was customer work — `return_exchange/problem` L3, team
    // logistics, the back office coordinating real returns — so skipping them
    // meant building no case file for a customer's return because a colleague
    // happened to be the one typing.
    //
    // The sender still reaches the model, as context: `buildInput` passes
    // `senderDirectory.lookup()` so the agent knows a colleague is writing and
    // does not mistake them for the customer. Context, not a gate. See
    // DECISIONS.md § Tickets dashboard.
    const triggerMessage = messages[messages.length - 1];

    // Before the investigation, so it cannot be influenced by it — and awaited
    // rather than raced, because the stored row must describe one message.
    const exemplarMatch = await matchExemplar({
      retrieveExemplar, ticket, message: triggerMessage, shopId, logger
    });

    let caseFile;
    try {
      caseFile = await investigate(
        buildInput(ticket, messages, senderDirectory, exemplarMatch.requirement_needs)
      );
    } catch (error) {
      await handleFailure({ record, ticket, error, counts, logger, dryRun });
      continue;
    }

    // The level may rise on what the evidence showed, never fall — the same
    // ratchet the categoriser uses, for the same reason.
    const level = ratchetLevel(ticket.level, caseFile.proposedLevel);

    counts[caseFile.verdict] += 1;
    onResult?.({ ticket, caseFile, level });

    if (!dryRun) {
      // THE CASE FILE FIRST, THE TICKET SECOND, and the order matters: the
      // ticket's flag is what says this ticket has been investigated, so
      // clearing it before the row exists would mark the work done with nothing
      // behind it. A crash between the two leaves a case file that will be
      // rewritten by the retry — the upsert key makes that harmless.
      await store.saveCaseFile({
        ticket,
        caseFile,
        shopId,
        triggerMessageId: triggerMessage.id,
        // Stamped with whether this row's needs came from the exemplar. A report
        // comparing the two declarations MUST exclude these, or it measures the
        // exemplar against a copy of itself.
        exemplarMatch: {
          ...exemplarMatch,
          ...(caseFile.needsSource === 'exemplar' ? { supplied_needs: true } : {})
        }
      });

      // WHERE THE VERDICT LEAVES THE TICKET IN THE QUEUE. `answerable` maps to
      // null and the ticket stays `open`: it means a reply could be written, not
      // that one was sent, and nothing sends yet.
      //
      // A CLOSED TICKET KEEPS ITS STATUS. Normally `claim` has already required
      // `status = 'open'`, so this can only move a ticket out of open and never
      // overrule a person. Under `--include-closed` that guarantee is the
      // operator's to make instead, and the verdict must not make it for them:
      // 65% of verdicts map to `awaiting_human` / `awaiting_customer`, so a
      // backfill over a historical corpus would otherwise resurrect dozens of
      // settled threads into the live queue. The case file is a note about the
      // thread; writing one is not a reason to reopen it.
      const nextStatus =
        ticket.status === 'open' ? (TICKET_STATUS_BY_VERDICT[caseFile.verdict] ?? null) : null;

      await record.complete('investigation', ticket, {
        columns: { level, ...(nextStatus ? { status: nextStatus } : {}) },
        trail: { verdict: caseFile.verdict },
        at: caseFile.investigatedAt
      });
    }

    const needs = summariseNeeds(caseFile.evidenceGaps);

    // No PII: ids, verdicts and counts only. The claims themselves stay in the
    // row, which is access-controlled; a log line is not.
    logger?.info?.('investigate.ticket', {
      ticketId: ticket.id,
      category: ticket.category,
      verdict: caseFile.verdict,
      established: caseFile.established.length,
      missing: caseFile.missing.length,
      dropped: caseFile.droppedClaims.length,
      toolCalls: caseFile.toolCalls.length,
      // The evidence report. `needsNotAttempted` is the one to watch: a tool was
      // allowed, the budget was there, and nothing called it.
      needsDeclared: needs.declared,
      needsSatisfied: needs.satisfied,
      needsNotAttempted: needs.not_attempted,
      needsComplete: needs.complete,
      // The situation this ticket looks like, decided independently of the run
      // above. Keys only — a phrasing is customer prose and does not go in a log.
      exemplarVerdict: exemplarMatch.verdict ?? null,
      // The closest rather than the committed one: on a near miss the committed
      // key is null, and which situation nearly won is the point of the line.
      exemplarKey: exemplarMatch.closest ?? null,
      ...(level !== ticket.level ? { handlingLevel: level, previousHandlingLevel: ticket.level } : {})
    });
  }

  return counts;
}

/**
 * A failed investigation is retried, then given up on — towards a human.
 *
 * Identical in shape to the categoriser's failure path, and for the identical
 * reason: a ticket that fails forever must not occupy a batch slot on every
 * poll, and what it becomes when we stop trying must be visible rather than
 * silent. There is no partial case file to keep, so the fallback is simply
 * "a person should look at this, and here is why".
 */
async function handleFailure({ record, ticket, error, counts, logger, dryRun }) {
  const attempts = attemptsSoFar(ticket.metadata, 'investigation') + 1;
  counts.failed += 1;
  logger?.warn?.('investigate.error', { ticketId: ticket.id, attempts, message: error.message });

  if (dryRun) {
    return;
  }

  if (attempts < MAX_ATTEMPTS) {
    await record.retry('investigation', ticket, { attempts, error });
    return;
  }

  await record.abandon('investigation', ticket, {
    trail: {
      verdict: 'needs_human',
      reason: 'investigation failed, routed to a human'
    },
    attempts,
    error
  });
  logger?.error?.('investigate.fallback', { ticketId: ticket.id, attempts });
}

/**
 * What the agent is given.
 *
 * First and latest inbound, as the categoriser does: the first says what was
 * originally asked (and is where a product name or a discount code is actually
 * written), the latest says where the customer stands now. The middle of a long
 * thread rarely changes either.
 */
/**
 * @param senderDirectory  optional; `emptySenderDirectory` behaviour when absent.
 *
 * WHY THE LOOKUP HAPPENS HERE and not as a tool the model can call: the sender is
 * already in hand on every ticket, and one indexed map lookup cannot fail. A tool
 * call would spend a round trip — and a slot of the six-call budget — asking a
 * question that was already answered, and the model would only ask when it
 * thought to.
 */
function buildInput(ticket, messages, senderDirectory, exemplarNeeds = []) {
  const first = messages[0];
  const latest = messages.length > 1 ? messages[messages.length - 1] : null;
  const text = [first?.body_text, latest?.body_text]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, MAX_TEXT_CHARS);

  return {
    id: ticket.id,
    subject: ticket.subject,
    text,
    category: ticket.category,
    request_kind: ticket.request_kind,
    level: ticket.level,
    customer_id: ticket.customer_id,
    requester_email_hash: ticket.requester_email_hash,
    shopify_order_number: ticket.shopify_order_number,
    // What this sender is to us, or null for an ordinary consumer. THE ADDRESS
    // IS NOT CARRIED — only the label, the note and the pattern that matched,
    // which is a company domain rather than personal data.
    sender: senderDirectory?.lookup(first?.from_email) ?? null,
    // STANDBY ONLY, and never shown to the model. `investigate` reads it solely
    // when the decomposer failed to produce needs of its own; while the
    // decomposer has spoken this is ignored, so the two declarations stay
    // independent and remain worth comparing.
    exemplarNeeds,
    // The bundle the order-context pass already assembled and stored. Read, not
    // re-derived: a second derivation of the same order would be a second,
    // divergent account of it.
    resolvedContext: ticket.resolved_context && Object.keys(ticket.resolved_context).length > 0
      ? ticket.resolved_context
      : null,
    // COMPUTED OVER EVERY INBOUND MESSAGE, not just the two that make up `text`.
    // A customer often writes "le flacon est cassé" and attaches the photo in a
    // second mail; taking only the first and latest would miss it whenever the
    // thread ran to three. It is a pure function of text and stored metadata, so
    // it is derived once here rather than inside a tool handler that would
    // recompute the same answer on every call.
    photoEvidence: summarisePhotoEvidence(messages)
  };
}

// `attemptsSoFar` and the metadata merge that used to sit here are the ticket
// record's — both existed twice, here and in the categoriser, character for
// character. The trail key comes from the pass descriptor now.

/**
 * Which recurring situation this ticket is, compressed for storage.
 *
 * NEVER FAILS A RUN. Exemplar matching is a diagnostic riding along beside the
 * investigation; a failing RPC, a missing vector or an unreachable embeddings
 * API must cost the case file nothing. Every failure resolves to `{}`, which
 * reads the same as "no exemplar came close" — deliberately, because both mean
 * the same thing to anyone querying this column: no situation was identified.
 * The log line is what distinguishes them.
 *
 * The stored shape is a summary, not the candidate list, and it keeps THREE
 * keys rather than one:
 *
 * - `exemplar_key` is the committed match, null unless the verdict is `matched`.
 * - `closest` is the nearest situation whatever the verdict. On a near miss that
 *   is the entire diagnostic — "the corpus almost covers this ticket, and here
 *   is what it almost is" — and storing only the committed match would throw it
 *   away on exactly the rows worth reading.
 * - `runner_up` because a persistent near-tie between the same two situations is
 *   the corpus asking to be merged, which is only visible across many rows.
 */
async function matchExemplar({ retrieveExemplar, ticket, message, shopId, logger }) {
  if (!retrieveExemplar) return {};

  try {
    const result = await retrieveExemplar(
      {
        subject: message.subject,
        body: message.body_text,
        category: ticket.category,
        // The vector ingestion already wrote, when it is there. Composed the same
        // way this query would be, so reusing it costs an API call rather than
        // accuracy; `resolveVector` embeds on demand when it is absent, because
        // that ingestion write is best-effort.
        embedding: message.embedding
      },
      { shopId }
    );

    return {
      verdict: result.verdict,
      exemplar_key: result.exemplar?.exemplarKey ?? null,
      closest: result.candidates?.[0]?.exemplarKey ?? null,
      similarity: round3(result.bestSimilarity),
      margin: round3(result.margin),
      runner_up: result.candidates?.[1]?.exemplarKey ?? null,
      // The claim being tested: that this situation's declared needs are the
      // ones the run turns out to require.
      requirement_needs: result.exemplar?.requirementNeeds ?? []
    };
  } catch (error) {
    logger?.warn?.('investigate.exemplar_failed', {
      ticketId: ticket.id,
      error: error.message
    });
    return {};
  }
}

function round3(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

/**
 * The case-file store: `ticket_investigations`, and nothing else.
 *
 * WHAT LEFT. This used to be the investigation's private view of the whole
 * ticket world — the queue query, the inbound-message reader, a generic
 * `updateTicket` escape hatch and a backfill that wrote `tickets` with a raw
 * `supabaseUpdate`, going around this very object. All four were the ticket row
 * rather than the case file, and they are now the shared record in
 * scripts/lib/ticket-record.mjs. What remains is the one table this pass
 * genuinely owns.
 */
export function createCaseFileStore(supabase) {
  return {
    /**
     * Writes the case file.
     *
     * The row is upserted on `(shop_id, trigger_message_id)`: one investigation
     * per inbound message that caused it. That is the idempotency key — a re-run
     * over the same thread rewrites its own row rather than adding a second —
     * and it leaves the ticket's trajectory as rows, so a thread that escalated
     * shows both readings.
     *
     * The TICKET is not touched here. `runInvestigation` calls
     * `record.complete('investigation', ...)` immediately afterwards, which is
     * what clears the flag and moves the status.
     */
    async saveCaseFile({ ticket, caseFile, shopId, triggerMessageId, exemplarMatch }) {
      await supabaseUpsert(
        supabase,
        T.TICKET_INVESTIGATIONS,
        [
          {
            shop_id: shopId,
            ticket_id: ticket.id,
            customer_id: ticket.customer_id || null,
            trigger_message_id: triggerMessageId,
            verdict: caseFile.verdict,
            established: caseFile.established,
            unverified: caseFile.unverified,
            missing: caseFile.missing,
            do_not_claim: caseFile.doNotClaim,
            knowledge: caseFile.knowledge,
            context_ref: caseFile.contextRef || {},
            handoff: caseFile.handoff,
            tool_calls: caseFile.toolCalls,
            evidence_gaps: caseFile.evidenceGaps,
            // Diagnostic, arrived at independently of everything above it.
            exemplar_match: exemplarMatch || {},
            dropped_claims: caseFile.droppedClaims,
            escalation_reasons: caseFile.escalationReasons,
            proposed_level: caseFile.proposedLevel,
            model: caseFile.model,
            investigated_at: caseFile.investigatedAt
          }
        ],
        'shop_id,trigger_message_id'
      );
    }
  };
}

/**
 * Puts already-categorised tickets into this pass's queue.
 *
 * Needed exactly twice in a system's life: at rollout, and whenever a subject
 * joins ENABLED_SUBJECTS — those tickets were skipped AND had their flag
 * cleared, so nothing re-queues them on its own.
 *
 * A thin wrapper over `record.raiseFor` rather than a query, because which
 * subjects are in scope is this module's business and the predicate that makes
 * re-raising safe is the ticket record's.
 */
export async function raiseForCategorised(record, { subjects = ENABLED_SUBJECTS, dryRun = false } = {}) {
  return record.raiseFor('investigation', {
    where: { category: { operator: 'in', value: `(${subjects.join(',')})` } },
    dryRun
  });
}

import { ratchetLevel } from '../../../scripts/lib/support-taxonomy.mjs';
import { supabaseUpsert } from '../../../scripts/lib/supabase-rest-client.mjs';
import { COLUMNS, T } from '../../../scripts/lib/tables.mjs';
import { attemptsSoFar } from '../../../scripts/lib/ticket-record.mjs';
import { splitQuotedReply } from '../../../scripts/lib/quoted-reply.mjs';

import { OWN_SIDE_LABELS, emptySenderDirectory } from '../ingestion/sender-directory.mjs';

import { TICKET_STATUS_BY_VERDICT } from './case-file.mjs';
import { summariseNeeds } from './evidence-rules.mjs';
import { normaliseConditions, resolveSituationTie,
  answerFromRow
} from './answer-selection.mjs';
import { ENABLED_SUBJECTS, answerSetFor, isInvestigable, isTradeSender } from './investigation-rules.mjs';
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
  // One ticket by id. Narrows the queue, never bypasses it -- see record.claim.
  ticketId = null,
  onResult,
  // Loaded once per poll by the caller and shared across tickets: it is a small
  // map, and rebuilding it per ticket would turn a lookup back into a query.
  senderDirectory = emptySenderDirectory,
  // The customer's most recent order, for a HUMAN to check first when no order
  // was confirmed. Optional; without it the pass runs exactly as before.
  //
  // NOT A TOOL, deliberately. The model cannot call it and never sees its
  // result, so surfacing recent orders on a `product` or `return_exchange`
  // ticket cannot nudge it into asking the customer for an order number — which
  // is what adding an order tool to those subjects would have done.
  lastOrderLookup = null,
  // Which recurring situation this ticket is. OPTIONAL, and absent by default so
  // that a caller which has not wired it runs exactly as it did before.
  //
  // ITS NEEDS ARE A FALLBACK, ITS IDENTITY IS A REPORT. `requirement_needs`
  // reaches `investigate` and stands in ONLY when the decomposer produced
  // nothing — `needsSource` records which happened, so a report comparing the
  // two declarations can exclude the rows where one supplied the other. Nothing
  // else about the match touches the run: no tool choice and no verdict depends
  // on it, and the situation key is used only after the ledger is closed, to
  // pick a policy rule for the shadow record.
  retrieveExemplar = null,
  // Settles a NEAR MISS OR A TIE by asking a small model which of the matcher's
  // candidates the opening message describes, or none. OPTIONAL: absent, a near
  // miss keeps no situation, as it did before. It runs before the rules load, so
  // the situation it picks drives the evidence collected and the rule selected.
  // See `situation-chooser.mjs`.
  chooseSituation = null,
  // The policy rules for a ticket's answer set. OPTIONAL and absent by default,
  // so a caller that has not wired it runs exactly as it did before — the same
  // contract as `retrieveExemplar` and `lastOrderLookup`.
  //
  // A LOADER RATHER THAN A STORE METHOD, because the case-file store's transport
  // is the seam the test chat replaces with an in-memory database. Rules are
  // read-only reference data like products and knowledge, so a rehearsal wants
  // the real ones; routing them through the fake would mean teaching it a table
  // it has no reason to know.
  loadAnswers = null,
  loadCollectionMode = null,
  // The numbers the desk runs on, loaded ONCE PER POLL by the caller and shared
  // across tickets — the same treatment `senderDirectory` gets, and for the same
  // reason: a small map, and rebuilding it per ticket turns a lookup into a
  // query. Absent by default, which resolves every parameter to null and every
  // state that depends on one to `unknown`.
  parameters = new Map()
} = {}) {
  const counts = {
    considered: 0,
    answerable: 0,
    needs_customer_input: 0,
    needs_human: 0,
    skipped: 0,
    failed: 0
  };

  const pending = await record.claim('investigation', { limit, anyStatus, ticketId });
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
    //
    // THE ONE EXCEPTION IS A RETAILER, and it is not the rule above reversed. Those
    // 14 threads were our side working a customer's problem; a retailer's thread
    // is a trade order that the consumer tools cannot see, handled like `b2b`.
    // Checked on the opening message, before the matcher spends an embedding.
    if (isTradeSender(senderDirectory?.lookup?.(messages[0]?.from_email))) {
      if (!dryRun) {
        await record.skip('investigation', ticket.id);
      }
      counts.skipped += 1;
      continue;
    }

    const triggerMessage = messages[messages.length - 1];

    // Before the investigation, so it cannot be influenced by it — and awaited
    // rather than raced, because the stored row must describe one message.
    // THE SITUATION IS MATCHED ON THE OPENING MESSAGE, NOT THE LATEST ONE, and
    // they answer different questions. The investigation asks « what does this
    // customer need now », so it is driven by `triggerMessage` — the most recent
    // thing they said. The matcher asks « what is this thread about », and that
    // is the request that opened it.
    //
    // MEASURED 2026-09-03, on the ticket that exposed it. A thread opening « je
    // constate que ma commande #6686 du 28 juillet n'est toujours pas traitée »
    // ends with « je vous confirme que j'ai bien reçu ma commande ». Scored on
    // the last message it reaches 0.623 against O-12, an address-change
    // situation whose nearest phrasing merely shares the words « je viens de
    // passer une commande »; scored on the first it reaches 0.869 against O-09,
    // which is plainly what it is. Across the nine multi-message threads in the
    // sample the opening message scored higher on six, and doubled the matches.
    //
    // IT ALSO REALIGNS PRODUCTION WITH THE CALIBRATION. The 0.65 band was
    // derived by `eval:exemplars` over the FIRST inbound message of 190 real
    // tickets, so scoring the last one applied a threshold to a distribution it
    // had never been measured against.
    //
    // FOLLOW-UPS ARE A SEPARATE PROBLEM AND THIS DOES NOT SOLVE IT. A thread
    // that opens « où est ma commande » and becomes « finalement je veux être
    // remboursé » still matches the first intent. What a later message should do
    // to a situation already matched is undecided: it is additive to the thread
    // rather than a new request, and treating it as a fresh match would let a
    // courtesy note redefine what a ticket is about.
    const openingMessage = messages[0];

    const exemplarMatch = await matchExemplar({
      retrieveExemplar, chooseSituation, senderDirectory, ticket, message: openingMessage, shopId, logger
    });

    // WHICH RULES COULD APPLY, loaded before the run and read after it.
    //
    // The set comes from the ticket's SUBJECT, not from the matched exemplar's
    // `answer_set` column: `match_support_exemplars()` does not return that
    // column, and today the two always agree because a family is a grouping of
    // subjects. Reading the column would need the function widened, for no
    // difference in outcome — worth doing the day a situation draws on a family
    // its subject does not imply, and not before.
    const policy = await loadPolicy({ loadAnswers, loadCollectionMode, ticket, exemplarMatch, shopId, logger });

    // A TIE THE RULES DO NOT CARE ABOUT IS NOT A TIE. The matcher refused to
    // separate two situations because their scores were inside the margin; that
    // refusal is made before any rule is in hand, so it cannot know whether the
    // choice changes an answer. Here it can be asked — and when both situations
    // reach the same rule whatever the evidence turns out to be, the tie is
    // settled on the key rather than thrown away with the needs it was carrying.
    //
    // NOTHING IS RELAXED WHEN IT MIGHT MATTER. `resolveSituationTie` returns
    // null the moment a rule names either situation or reads a need they
    // disagree on, and the ticket keeps the unmatched verdict it had.
    resolveTiedSituation({ exemplarMatch, policy, ticket, logger });

    let caseFile;
    try {
      caseFile = await investigate(
        buildInput(ticket, messages, senderDirectory, exemplarMatch.requirement_needs, policy, parameters)
      );
    } catch (error) {
      await handleFailure({ record, ticket, error, counts, logger, dryRun });
      continue;
    }

    // AFTER the case file is complete, so it cannot touch the verdict or what
    // the ticket asks the customer for. Only when nothing was confirmed: with a
    // confirmed order the bundle already says everything this could.
    if (lastOrderLookup && !ticket.shopify_order_number && ticket.customer_id) {
      try {
        caseFile.candidateOrder = (await lastOrderLookup(ticket.customer_id)) || {};
      } catch (error) {
        // A lead is worth having and never worth failing an investigation for.
        logger?.warn?.('investigate.candidate_order_failed', {
          ticketId: ticket.id,
          reason: error.message
        });
      }
    }

    // The level may rise on what the evidence showed, never fall — the same
    // ratchet the categoriser uses, for the same reason.
    const level = ratchetLevel(ticket.level, caseFile.proposedLevel);

    counts[caseFile.verdict] += 1;
    // The match goes out with the case file because the test chat has no row to
    // read it back from — its store is in memory and discarded with the run.
    onResult?.({ ticket, caseFile, level, exemplarMatch });

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
          ...(caseFile.needsSource === 'exemplar' ? { supplied_needs: true } : {}),
          // THE SHADOW RECORD, and it lives inside this jsonb rather than in a
          // column of its own. `ticket_investigations` is populated, so a new
          // column is a forward step against real rows; this is the same
          // diagnostic subsystem and the same lifecycle, and DECISIONS already
          // records extending an existing jsonb as the cheaper correct move
          // (`evidence_gaps`, § Investigation). It becomes a column the day
          // something reads it in anger.
          ...(caseFile.policy ? { policy: caseFile.policy } : {})
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
 *
 * QUOTED HISTORY IS SPLIT OFF, NOT DELETED, and until 2026-09-16 it was neither.
 * `text` was the raw bodies joined, so every tool reading it — `lookupProduct`,
 * `extractPromotionCodes`, `concernsInText`, the trade-signal amount reader —
 * read whatever the customer happened to be replying on top of as if they had
 * written it. The stripper existed and was already used for the embedding and
 * the categoriser (`scripts/lib/quoted-reply.mjs`); this path simply never
 * called it. 92 of the mailbox's 233 inbound messages carry a quote, 186,619
 * characters of it.
 *
 * MEASURED ON THE TICKET THAT FOUND IT (`b7b276f6`, 4 Sep): Martine asked, in
 * 278 characters, for our equivalent of a competitor's anti-wrinkle serum — on
 * top of 2,086 characters of our own -30% newsletter advertising « Crème
 * Hydratante Eclat Acide Hyaluronique & Niacinamide ». The matcher is
 * IDF-weighted over the text, so the newsletter outvoted her and
 * `lookupProduct` returned « Crème Anti-Âge Homme - Acide Hyaluronique &
 * Niacinamide », a men's cream assembled out of our own marketing. On her words
 * alone it returns « Crème anti-rides & anti-âge - Caresse d'Exception ».
 *
 * THE QUOTE IS KEPT, on `quotedText`, because it is evidence rather than noise:
 * a forwarded order confirmation is the one place the order number and the
 * address it is registered to both appear. Order resolution is an earlier,
 * separate pass reading the whole body from its own query, so nothing there
 * changes (`confirmation-evidence.mjs`) — this is carried so that "where does
 * the quote begin" has one answer in this codebase rather than two. It is never
 * shown to the model.
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
function buildInput(ticket, messages, senderDirectory, exemplarNeeds = [], policy = null, parameters = new Map()) {
  const first = messages[0];
  const latest = messages.length > 1 ? messages[messages.length - 1] : null;
  const parts = [first?.body_text, latest?.body_text].filter(Boolean).map(splitQuotedReply);
  const text = parts
    .map((part) => part.own)
    .filter(Boolean)
    .join('\n\n')
    .slice(0, MAX_TEXT_CHARS);
  const quotedText =
    parts
      .map((part) => part.quoted)
      .filter(Boolean)
      .join('\n\n')
      .slice(0, MAX_TEXT_CHARS) || null;

  return {
    id: ticket.id,
    subject: ticket.subject,
    text,
    quotedText,
    category: ticket.category,
    request_kind: ticket.request_kind,
    level: ticket.level,
    customer_id: ticket.customer_id,
    requester_email_hash: ticket.requester_email_hash,
    shopify_order_number: ticket.shopify_order_number,
    // The order's buyer is a marketplace placeholder — accepted on its number by
    // the resolver, or linked by a person (order-link.mjs). No customer record can match the sender,
    // so no address is worth asking for — the lookup and the case file both
    // read this to stop the question reaching the customer.
    orderBuyerAnonymous:
      ticket.metadata?.order_resolution?.buyer_anonymous === true ||
      // Written before the flag existed (#6059, #6308).
      ticket.metadata?.order_resolution?.verified_by === 'marketplace_order_number',
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
    photoEvidence: summarisePhotoEvidence(messages),
    // THE POLICY RULES FOR THIS TICKET, and the situation they may be keyed to.
    //
    // READ AFTER THE RUN, NEVER BEFORE IT. `investigate` uses this only once the
    // tool loop has finished, to score the ledger it already produced against
    // the rules — so no tool choice, no declared need and no model turn can
    // depend on which rules exist. That ordering is what makes the shadow phase
    // meaningful: the run is byte-for-byte the run that would have happened.
    policy,
    // Read by the order tool to derive `return_eligibility`, and by nothing that
    // talks to the model: a parameter is an input to a calculation, never a
    // sentence handed over.
    parameters
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
async function matchExemplar({ retrieveExemplar, chooseSituation = null, senderDirectory = null, ticket, message, shopId, logger }) {
  if (!retrieveExemplar) return {};

  let summary;
  let result;
  try {
    result = await retrieveExemplar(
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

    summary = {
      verdict: result.verdict,
      exemplar_key: result.exemplar?.exemplarKey ?? null,
      closest: result.candidates?.[0]?.exemplarKey ?? null,
      // The nearest situation's canonical question, so a reader of a miss sees
      // WHAT it almost was without looking the key up.
      closest_question: result.candidates?.[0]?.question ?? null,
      similarity: round3(result.bestSimilarity),
      margin: round3(result.margin),
      runner_up: result.candidates?.[1]?.exemplarKey ?? null,
      // The claim being tested: that this situation's declared needs are the
      // ones the run turns out to require.
      requirement_needs: result.exemplar?.requirementNeeds ?? [],
      // Carried only so `resolveSituationTie` can be asked whether this tie
      // decides anything, once the rules are loaded and there is something to
      // ask it against. Empty on every match that was not ambiguous.
      tied: (result.tied ?? []).map((m) => ({
        exemplarKey: m.exemplarKey,
        requirementNeeds: m.requirementNeeds ?? []
      }))
    };
  } catch (error) {
    logger?.warn?.('investigate.exemplar_failed', {
      ticketId: ticket.id,
      error: error.message
    });
    return {};
  }

  await settleWithChooser({ summary, result, chooseSituation, senderDirectory, ticket, message, logger });
  return summary;
}

/**
 * A near miss or a tie, settled by the chooser — or left unsettled, and recorded
 * either way under `chooser`.
 *
 * THE VERDICT IS LEFT AS THE MATCHER GAVE IT. `near` or `ambiguous` stays the
 * record of what the embedding could and could not tell, exactly as a settled
 * tie keeps `ambiguous`; `chosen_by: 'model'` says who supplied the key. A
 * report of how the corpus is covering tickets must still be able to count the
 * misses the model rescued.
 *
 * OUR OWN SIDE IS SKIPPED. A colleague writing to the warehouse is not a customer
 * describing a situation, and measured it was where the chooser went wrong: four
 * internal threads, some given a situation they were only worded like.
 *
 * A FAILED CALL IS NO SITUATION, never a failed investigation — the same contract
 * the matcher itself keeps.
 */
async function settleWithChooser({ summary, result, chooseSituation, senderDirectory, ticket, message, logger }) {
  if (!chooseSituation || summary.exemplar_key) return;
  if (summary.verdict !== 'near' && summary.verdict !== 'ambiguous') return;

  const sender = senderDirectory?.lookup?.(message.from_email);
  if (sender && OWN_SIDE_LABELS.includes(sender.label)) {
    summary.chooser = { skipped: 'own_side' };
    return;
  }

  let picked;
  try {
    picked = await chooseSituation({
      subject: message.subject,
      body: message.body_text,
      candidates: result.candidates ?? [],
      ticketId: ticket.id
    });
  } catch (error) {
    logger?.warn?.('investigate.situation_chooser_failed', { ticketId: ticket.id, error: error.message });
    summary.chooser = { failed: true };
    return;
  }

  summary.chooser = {
    model: picked.model,
    choice: picked.choice ?? 'none',
    reason: picked.reason,
    candidates: picked.candidates
  };

  const chosen = picked.choice
    ? (result.candidates ?? []).find((candidate) => candidate.exemplarKey === picked.choice)
    : null;
  if (!chosen) return;

  summary.exemplar_key = chosen.exemplarKey;
  summary.requirement_needs = chosen.requirementNeeds ?? [];
  summary.chosen_by = 'model';
  // Settled: a tie the model decided is not handed on for the rules to decide.
  summary.tied = [];

  logger?.info?.('investigate.situation_chosen', {
    ticketId: ticket.id,
    chosen: chosen.exemplarKey,
    verdict: summary.verdict,
    similarity: summary.similarity
  });
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
/**
 * @param transport  the PostgREST call this store makes, injectable for the same
 *   reason `ticket-record.mjs` and `draft-record.mjs` inject theirs: the test
 *   chat runs the whole pass against an in-memory database, and a store that
 *   reached for `supabaseUpsert` directly would be the one thing in the
 *   investigation that could not be run without writing a row.
 */
export function createCaseFileStore(supabase, { transport = CASE_FILE_TRANSPORT } = {}) {
  const { upsert } = transport;
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
      return upsert(
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
            candidate_order: caseFile.candidateOrder || {},
            reaction_report: caseFile.reactionReport ?? null,
            tool_calls: caseFile.toolCalls,
            evidence_gaps: caseFile.evidenceGaps,
            // NULL RATHER THAN `[]` WHEN THERE IS NONE, matching the column: an
            // empty array says the run made no tool calls, and null says the row
            // predates the trace. A case file always carries one, so this only
            // fires for a caller that built one without the investigation.
            findings_trace: caseFile.findingsTrace ?? null,
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
 * The rules for this ticket's answer set, shaped the way `selectAnswer` reads
 * them, or null when there are none.
 *
 * NEVER FAILS THE INVESTIGATION. A shadow record is worth having and never worth
 * losing a case file for, so a loader that throws is logged and the run
 * continues exactly as it would without one — the same contract `lastOrderLookup`
 * already has for the same reason.
 */
async function loadPolicy({ loadAnswers, loadCollectionMode, ticket, exemplarMatch, shopId, logger }) {
  const answerSet = answerSetFor(ticket.category);
  if (!loadAnswers || !answerSet) {
    return null;
  }

  try {
    const rows = await loadAnswers({ shopId, answerSet });
    const answers = (rows || []).map(answerFromRow);

    // OPT-IN, AND ONLY WHERE A SITUATION MATCHED. Without a situation there is
    // nothing to have opted in, so the mode stays `model` and the planner never
    // runs — which is also the safe reading of a loader that failed.
    const situationKey = exemplarMatch?.exemplar_key ?? null;
    let collectionMode = 'model';
    let suppresses = false;
    if (situationKey && loadCollectionMode) {
      try {
        const mode = await loadCollectionMode({ shopId, exemplarKey: situationKey });
        collectionMode = mode?.collectionMode ?? 'model';
        suppresses = mode?.suppresses === true;
      } catch (error) {
        logger?.warn?.('investigation.collection_mode_load_failed', {
          ticketId: ticket.id,
          reason: error.message
        });
      }
    }

    return answers.length > 0
      ? { answerSet, situationKey, collectionMode, suppresses, answers }
      : null;
  } catch (error) {
    logger?.warn?.('investigation.policy_load_failed', {
      ticketId: ticket.id,
      answerSet,
      reason: error.message
    });
    return null;
  }
}

/**
 * Settles an ambiguous exemplar match when the rules make the choice free.
 *
 * MUTATES BOTH, deliberately and in one place. The match and the policy each
 * hold the situation — `exemplar_match` because it is the record of what the
 * matcher saw, `policy.situationKey` because it is what `selectAnswer` reads —
 * and updating one without the other would leave a run whose stored diagnosis
 * disagrees with the rule it fired. They are written together here, or not at
 * all.
 *
 * THE VERDICT STAYS `ambiguous`. What is recorded is that a tie existed and was
 * resolved, not that the matcher was confident: `resolved_from` names the
 * situations that were level, so a corpus review still sees the pair asking to
 * be merged. Overwriting the verdict with `matched` would erase the only signal
 * that these two situations are indistinguishable to the embeddings.
 */
function resolveTiedSituation({ exemplarMatch, policy, ticket, logger }) {
  // CONSUMED, NOT STORED. `tied` exists to get the candidates from the matcher
  // to this function; the whole object is written to `exemplar_match` jsonb, and
  // an empty array on all several hundred unambiguous matches would be a column
  // carrying scaffolding. `resolved_from` is the part worth keeping, and it is
  // only ever set on the runs where something actually happened.
  const tied = exemplarMatch?.tied ?? [];
  delete exemplarMatch?.tied;

  // A key already set means the chooser settled it; the rules are not asked again.
  if (!policy || exemplarMatch?.verdict !== 'ambiguous' || exemplarMatch?.exemplar_key) {
    return;
  }

  const chosen = resolveSituationTie(policy.answers, tied);
  if (!chosen) {
    return;
  }

  exemplarMatch.exemplar_key = chosen.exemplarKey;
  exemplarMatch.requirement_needs = chosen.requirementNeeds ?? [];
  exemplarMatch.resolved_from = tied.map((s) => s.exemplarKey);
  policy.situationKey = chosen.exemplarKey;

  logger?.info?.('investigate.situation_tie_resolved', {
    ticketId: ticket.id,
    chosen: chosen.exemplarKey,
    among: exemplarMatch.resolved_from,
    margin: exemplarMatch.margin
  });
}

/** The PostgREST call the case-file store makes, as one object. */
export const CASE_FILE_TRANSPORT = { upsert: supabaseUpsert };

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

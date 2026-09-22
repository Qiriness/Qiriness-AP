import { ratchetLevel } from '../../../scripts/lib/support-taxonomy.mjs';
import { attemptsSoFar } from '../../../scripts/lib/ticket-record.mjs';

import { normaliseCategorisation } from './categorise.mjs';

// Batch pass that categorises tickets ingestion has created, and RE-categorises
// them as their threads grow.
//
// Deliberately a separate pass rather than a step inside ticket-writer: the
// pending set is "tickets flagged needs_categorisation", which makes the pass
// idempotent, catch-up-safe (a poll that crashed mid-batch just re-selects the
// stragglers), and re-runnable without touching ingestion. It also means a
// ticket is never lost because the categoriser was down when its email arrived.
//
// The flag is what makes re-categorisation fall out of the same machinery:
// ingestion raises it whenever a new inbound message joins a thread, so a reply
// puts the ticket back in exactly the queue a brand-new ticket sits in, and one
// code path serves both. A ticket's labels are a reading of the conversation so
// far, not a stamp applied once to its first email.
//
// The ticket record is injected so the batching, retry and fallback logic can be
// unit-tested without a database. It is the shared one —
// scripts/lib/ticket-record.mjs — and this pass is one of two that run off a
// flag, so the claim/complete/skip/retry/abandon cycle below is that module's
// protocol rather than anything specific to categorisation.

const DEFAULT_BATCH_LIMIT = 25;
// Failures leave the ticket pending so the next poll retries it. After this many
// attempts it is categorised by fallback instead, which keeps one poison ticket
// from occupying a batch slot forever.
const MAX_ATTEMPTS = 3;
// Enough thread context for the categoriser; the first and last are what it uses.
const MESSAGES_PER_TICKET = 10;
// How many superseded label sets to keep on the ticket. Enough to see a
// trajectory (where the thread started, how it escalated) without the metadata
// column growing without bound on a long-running conversation.
const HISTORY_LIMIT = 5;

// `ticketId` NARROWS THE BATCH TO ONE, and it narrows rather than bypasses: the
// flag, the status and the soft-delete filters still apply, so naming a ticket
// that is not due returns nothing rather than re-labelling it anyway. That is
// `record.claim`'s own rule and this only passes the argument through.
//
// It exists for the same reason the investigation CLI has `--ticket`: the queue
// is oldest-first over a corpus that keeps gaining older mail, so a recent
// ticket sits at the BACK of it. Re-reading one by hand otherwise means paying
// to re-read everything in front of it.
export async function runCategorisation({
  record,
  categorise,
  logger,
  limit = DEFAULT_BATCH_LIMIT,
  ticketId = null,
  // Answers « did the Case Manager read this thread as a continuation? ». Absent
  // by default, and absent means every ticket is re-categorised exactly as it
  // was before this layer existed.
  labelsStillValid = null
}) {
  const counts = { categorised: 0, recategorised: 0, kept: 0, skipped: 0, failed: 0, fallbacks: 0 };
  const pending = await record.claim('categorisation', { limit, ticketId });

  for (const ticket of pending) {
    const messages = await record.inboundMessages(ticket.id, { limit: MESSAGES_PER_TICKET });
    if (messages.length === 0) {
      // Nothing from the customer (a thread where we hold only our own replies,
      // because the customer's original fell outside the ingested window). There
      // is nothing to classify, so the ticket is not guessed at — but the flag
      // IS cleared, because leaving it pending parks it at the front of an
      // oldest-first batch for good. Measured on a real inbox, 11 such tickets
      // took 11 of every 25 slots on every pass, and they accumulate.
      //
      // Safe to clear precisely because it is not permanent: ingestion re-raises
      // the flag the moment an inbound message joins the thread, which is the
      // only event that makes this ticket classifiable.
      await record.skip('categorisation', ticket.id);
      counts.skipped += 1;
      continue;
    }

    // THE CASE MANAGER MAY HAVE SETTLED THIS ALREADY. On a `continuation` the
    // labels still describe the thread — the same request, moved along — so the
    // call is skipped and the EXISTING labels are re-completed.
    //
    // SKIPPED, NOT BYPASSED, and the difference matters. `complete` is what
    // clears `needs_categorisation` and raises `needs_investigation` in the same
    // patch; a pass that jumped over it would leave the ticket uninvestigated.
    // So the pass runs exactly as before and only the model call goes.
    //
    // RE-CATEGORISATION IS BLIND BY DESIGN, which is what makes this worth
    // doing rather than merely cheap: on a courtesy follow-up a blind re-read
    // can only ratchet the level or rewrite a subject that was already right.
    if (labelsStillValid?.(ticket)) {
      await record.complete('categorisation', ticket, {
        columns: {
          category: ticket.category,
          request_kind: ticket.request_kind,
          secondary_category: ticket.secondary_category,
          secondary_request_kind: ticket.secondary_request_kind,
          level: ticket.level,
          responsible_team: ticket.responsible_team,
          categorisation_confidence: ticket.categorisation_confidence ?? null,
          language: ticket.language,
          happiness: ticket.happiness
        },
        trail: { kept: true, reason: 'continuation' }
      });
      counts.kept += 1;
      continue;
    }

    let result;
    try {
      // Blind: the ticket's existing labels are deliberately not passed in. The
      // ticket id rides in the second argument, which is bookkeeping (whose cost
      // this call was) and never reaches the prompt.
      result = await categorise({ subject: ticket.subject, messages }, { ticketId: ticket.id });
    } catch (error) {
      await handleFailure(record, ticket, error, counts, logger);
      continue;
    }

    // A re-run, not a first pass — the ticket already carried labels.
    const isRecategorisation = Boolean(ticket.category);
    // The ratchet: a fresh reading may raise the level but never lower it, so a
    // calmer follow-up cannot walk back work the ticket has already earned.
    const level = ratchetLevel(ticket.level, result.level);

    // `complete` writes the labels, stamps `categorised_at`, clears
    // `needs_categorisation` LAST and raises `needs_investigation` in the same
    // patch — the crash-safety rule and the hand-off between the two passes both
    // live in ticket-record.mjs now, because both were being restated here and
    // in the investigation runner.
    //
    // It also resets attempts / last_error / failed: a success starts the next
    // pending cycle clean, so a ticket that stumbled twice months ago gets its
    // full three attempts again when a reply puts it back in the queue.
    await record.complete('categorisation', ticket, {
      columns: {
        category: result.category,
        request_kind: result.request_kind,
        secondary_category: result.secondary_category,
        secondary_request_kind: result.secondary_request_kind,
        level,
        responsible_team: result.responsible_team,
        // Cleared, not set: the column now means "these labels are known to be
        // untrustworthy", written only by the failure paths below. A successful
        // categorisation has no such caveat, and leaving a stale `low` here would
        // keep flagging a ticket that has since been read cleanly.
        //
        // The model is no longer asked how sure it is — see categorise.mjs.
        categorisation_confidence: null,
        language: result.language,
        happiness: result.happiness
      },
      trail: {
        model: result.model,
        reason: result.reason,
        runs: runsSoFar(ticket.metadata) + 1,
        // What the model actually said, before the ratchet — otherwise a
        // ticket pinned at 3 by an earlier message looks like the model keeps
        // choosing 3, and a drop in real severity becomes invisible.
        proposed_level: result.level,
        history: isRecategorisation
          ? appendHistory(ticket.metadata, ticket)
          : historySoFar(ticket.metadata)
      }
    });

    if (isRecategorisation) {
      counts.recategorised += 1;
    } else {
      counts.categorised += 1;
    }

    // No PII: ids and labels only.
    //
    // `handlingLevel`, not `level`: the logger puts its own severity in a field
    // called `level`, and a field named the same here silently overwrites it —
    // every categorisation line came out as {"level":2} instead of
    // {"level":"info"}, which breaks filtering by severity in any log viewer.
    logger?.info?.(isRecategorisation ? 'categorise.ticket_updated' : 'categorise.ticket', {
      ticketId: ticket.id,
      category: result.category,
      requestKind: result.request_kind,
      handlingLevel: level,
      confidence: result.confidence,
      happiness: result.happiness,
      language: result.language,
      ...(isRecategorisation && level !== ticket.level
        ? { previousHandlingLevel: ticket.level }
        : {})
    });
  }

  return counts;
}

async function handleFailure(record, ticket, error, counts, logger) {
  const attempts = attemptsSoFar(ticket.metadata, 'categorisation') + 1;
  logger?.warn?.('categorise.error', { ticketId: ticket.id, attempts, message: error.message });

  if (attempts < MAX_ATTEMPTS) {
    // Still retryable: `retry` records the attempt and touches no flag, so the
    // ticket stays in the pending set and the next poll picks it up again.
    await record.retry('categorisation', ticket, { attempts, error });
    counts.failed += 1;
    return;
  }

  // Out of retries. Clear the flag either way — otherwise a permanently failing
  // ticket occupies a batch slot on every poll forever — but what gets written
  // depends on whether the ticket has usable labels already.
  // Note what this patch does NOT do: raise needs_investigation. These labels
  // are either stale or a fallback, and investigating a guess would spend tool
  // and model calls building a case file on a subject nobody chose. Both
  // branches below already land the ticket in front of a human.
  const columns = {
    // The labels no longer reflect the newest message, whichever branch we take.
    categorisation_confidence: 'low'
  };

  if (ticket.category) {
    // A re-categorisation that failed. The previous labels were a real judgement
    // of a real (if shorter) conversation, so overwriting them with the (other,
    // problem) fallback would destroy information to express "we don't know" —
    // strictly worse than keeping a slightly stale reading. They stay, marked
    // low-confidence and flagged failed, and the level ratchet means they were
    // never an under-statement of the work owed.
    logger?.error?.('categorise.stale', { ticketId: ticket.id, attempts });
  } else {
    // Never categorised at all. Fall back *towards a human* rather than leaving
    // the ticket invisible: normalising an empty answer yields (other, problem)
    // -> level 3, team contact, so it surfaces in the queue as needing action.
    // The metadata says it was not actually judged, so a fallback is never read
    // as a verdict.
    const fallback = normaliseCategorisation({});
    Object.assign(columns, {
      category: fallback.category,
      request_kind: fallback.request_kind,
      secondary_category: null,
      secondary_request_kind: null,
      level: fallback.level,
      responsible_team: fallback.responsible_team
    });
    logger?.error?.('categorise.fallback', { ticketId: ticket.id, attempts });
  }

  // `abandon` clears the flag and stamps `categorised_at`, and deliberately does
  // NOT raise needs_investigation — see the note above and ticket-record.mjs.
  await record.abandon('categorisation', ticket, {
    columns,
    trail: { reason: 'categorisation failed, routed to a human' },
    attempts,
    error
  });
  counts.failed += 1;
  counts.fallbacks += 1;
}

function runsSoFar(metadata) {
  const runs = metadata?.categorisation?.runs;
  return Number.isInteger(runs) ? runs : 0;
}

function historySoFar(metadata) {
  const history = metadata?.categorisation?.history;
  return Array.isArray(history) ? history : [];
}

/**
 * Keeps the labels being replaced, so a ticket shows its trajectory rather than
 * only its latest reading — which is what makes an escalation legible after the
 * fact ("started as an order question at level 2, became a refund at 3").
 * Newest first, capped at HISTORY_LIMIT.
 */
function appendHistory(metadata, ticket) {
  const superseded = {
    category: ticket.category,
    request_kind: ticket.request_kind ?? null,
    level: ticket.level ?? null,
    happiness: ticket.happiness ?? null,
    at: metadata?.categorisation?.at ?? null
  };
  return [superseded, ...historySoFar(metadata)].slice(0, HISTORY_LIMIT);
}

// The store this file used to define is now the shared ticket record: the queue
// predicate is the `categorisation` descriptor in scripts/lib/ticket-record.mjs,
// the inbound-message reader is `record.inboundMessages` (it was written
// identically here and in the investigation runner), and `mergeMetadata` is that
// module's trail merge — it existed twice, character for character.

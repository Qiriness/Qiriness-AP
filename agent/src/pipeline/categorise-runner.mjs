import { ratchetLevel } from '../../../scripts/lib/support-taxonomy.mjs';
import {
  supabaseSelect,
  supabaseUpdateById
} from '../../../scripts/lib/supabase-rest-client.mjs';

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
// The store interface is injected so the batching, retry and fallback logic can
// be unit-tested without a database; createSupabaseCategoriserStore is the real
// impl.

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

export async function runCategorisation({
  store,
  categorise,
  shopId,
  logger,
  limit = DEFAULT_BATCH_LIMIT
}) {
  const counts = { categorised: 0, recategorised: 0, skipped: 0, failed: 0, fallbacks: 0 };
  const pending = await store.findTicketsNeedingCategorisation(shopId, limit);

  for (const ticket of pending) {
    const messages = await store.findInboundMessages(ticket.id, MESSAGES_PER_TICKET);
    if (messages.length === 0) {
      // Nothing from the customer yet (an outbound-only thread): there is
      // nothing to classify, so leave it pending rather than guessing.
      counts.skipped += 1;
      continue;
    }

    let result;
    try {
      // Blind: the ticket's existing labels are deliberately not passed in.
      result = await categorise({ subject: ticket.subject, messages });
    } catch (error) {
      await handleFailure(store, ticket, error, counts, logger);
      continue;
    }

    // A re-run, not a first pass — the ticket already carried labels.
    const isRecategorisation = Boolean(ticket.category);
    // The ratchet: a fresh reading may raise the level but never lower it, so a
    // calmer follow-up cannot walk back work the ticket has already earned.
    const level = ratchetLevel(ticket.level, result.level);

    await store.updateTicket(ticket.id, {
      category: result.category,
      request_kind: result.request_kind,
      secondary_category: result.secondary_category,
      secondary_request_kind: result.secondary_request_kind,
      level,
      responsible_team: result.responsible_team,
      categorisation_confidence: result.confidence,
      language: result.language,
      happiness: result.happiness,
      categorised_at: new Date().toISOString(),
      // Cleared last: until this is false the ticket stays in the pending set, so
      // a crash anywhere above leaves it to be retried rather than half-labelled.
      needs_categorisation: false,
      metadata: mergeMetadata(ticket.metadata, {
        model: result.model,
        reason: result.reason,
        at: new Date().toISOString(),
        // Consecutive failures in the CURRENT pending cycle, so it resets here:
        // a ticket that stumbled twice months ago must get its full three
        // attempts again when a new reply puts it back in the queue.
        attempts: 0,
        // Errors belong to the attempt that failed; a success clears them so a
        // long-lived ticket does not carry a stale error next to good labels.
        last_error: null,
        failed: null,
        runs: runsSoFar(ticket.metadata) + 1,
        // What the model actually said, before the ratchet — otherwise a
        // ticket pinned at 3 by an earlier message looks like the model keeps
        // choosing 3, and a drop in real severity becomes invisible.
        proposed_level: result.level,
        history: isRecategorisation
          ? appendHistory(ticket.metadata, ticket)
          : historySoFar(ticket.metadata)
      })
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

async function handleFailure(store, ticket, error, counts, logger) {
  const attempts = attemptsSoFar(ticket.metadata) + 1;
  logger?.warn?.('categorise.error', { ticketId: ticket.id, attempts, message: error.message });

  if (attempts < MAX_ATTEMPTS) {
    // Still retryable: record the attempt but leave category null so the next
    // poll picks it up again.
    await store.updateTicket(ticket.id, {
      metadata: mergeMetadata(ticket.metadata, {
        attempts,
        last_error: error.message,
        at: new Date().toISOString()
      })
    });
    counts.failed += 1;
    return;
  }

  // Out of retries. Clear the flag either way — otherwise a permanently failing
  // ticket occupies a batch slot on every poll forever — but what gets written
  // depends on whether the ticket has usable labels already.
  const patch = {
    // The labels no longer reflect the newest message, whichever branch we take.
    categorisation_confidence: 'low',
    categorised_at: new Date().toISOString(),
    needs_categorisation: false,
    metadata: mergeMetadata(ticket.metadata, {
      attempts,
      failed: true,
      last_error: error.message,
      reason: 'categorisation failed, routed to a human',
      at: new Date().toISOString()
    })
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
    Object.assign(patch, {
      category: fallback.category,
      request_kind: fallback.request_kind,
      secondary_category: null,
      secondary_request_kind: null,
      level: fallback.level,
      responsible_team: fallback.responsible_team
    });
    logger?.error?.('categorise.fallback', { ticketId: ticket.id, attempts });
  }

  await store.updateTicket(ticket.id, patch);
  counts.failed += 1;
  counts.fallbacks += 1;
}

function attemptsSoFar(metadata) {
  const attempts = metadata?.categorisation?.attempts;
  return Number.isInteger(attempts) ? attempts : 0;
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

// metadata is a single jsonb column shared with anything else that annotates a
// ticket, so patch the `categorisation` key rather than replacing the object.
function mergeMetadata(metadata, categorisation) {
  const base = metadata && typeof metadata === 'object' ? metadata : {};
  return { ...base, categorisation: { ...base.categorisation, ...categorisation } };
}

export function createSupabaseCategoriserStore(supabase) {
  return {
    async findTicketsNeedingCategorisation(shopId, limit) {
      return supabaseSelect(
        supabase,
        'tickets',
        {
          shop_id: shopId,
          status: 'open',
          // The flag, not "category is null": that older predicate could only
          // ever match a ticket once, which is what froze a label at the state
          // of a thread's first email. Set on insert and re-set by ingestion
          // when a new inbound message lands (03_categorisation.sql).
          needs_categorisation: { operator: 'is', value: 'true' },
          deleted_at: { operator: 'is', value: 'null' },
          archived_at: { operator: 'is', value: 'null' }
        },
        // category / request_kind / level / happiness come back because a re-run
        // needs the previous reading: the level to ratchet against, the rest to
        // put into the history trail before they are replaced.
        'id,subject,metadata,category,request_kind,level,happiness',
        // Oldest first: a support queue is served in arrival order.
        { order: 'first_message_at.asc', limit }
      );
    },

    async findInboundMessages(ticketId, limit) {
      return supabaseSelect(
        supabase,
        'ticket_messages',
        {
          ticket_id: ticketId,
          direction: 'inbound',
          deleted_at: { operator: 'is', value: 'null' }
        },
        'subject,body_text,received_at',
        { order: 'received_at.asc', limit }
      );
    },

    async updateTicket(ticketId, patch) {
      await supabaseUpdateById(supabase, 'tickets', ticketId, patch);
    }
  };
}

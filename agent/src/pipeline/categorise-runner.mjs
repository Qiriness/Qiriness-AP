import {
  supabaseSelect,
  supabaseUpdateById
} from '../../../scripts/lib/supabase-rest-client.mjs';

import { normaliseCategorisation } from './categorise.mjs';

// Batch pass that categorises tickets ingestion has created.
//
// Deliberately a separate pass rather than a step inside ticket-writer: the
// pending set is "tickets where category is null", which makes the pass
// idempotent, catch-up-safe (a poll that crashed mid-batch just re-selects the
// stragglers), and re-runnable without touching ingestion. It also means a
// ticket is never lost because the categoriser was down when its email arrived.
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

export async function runCategorisation({
  store,
  categorise,
  shopId,
  logger,
  limit = DEFAULT_BATCH_LIMIT
}) {
  const counts = { categorised: 0, skipped: 0, failed: 0, fallbacks: 0 };
  const pending = await store.findUncategorisedTickets(shopId, limit);

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
      result = await categorise({ subject: ticket.subject, messages });
    } catch (error) {
      await handleFailure(store, ticket, error, counts, logger);
      continue;
    }

    await store.updateTicket(ticket.id, {
      category: result.category,
      request_kind: result.request_kind,
      secondary_category: result.secondary_category,
      secondary_request_kind: result.secondary_request_kind,
      level: result.level,
      responsible_team: result.responsible_team,
      metadata: mergeMetadata(ticket.metadata, {
        model: result.model,
        reason: result.reason,
        at: new Date().toISOString(),
        attempts: attemptsSoFar(ticket.metadata) + 1
      })
    });
    counts.categorised += 1;
    // No PII: ids and labels only.
    logger?.info?.('categorise.ticket', {
      ticketId: ticket.id,
      category: result.category,
      requestKind: result.request_kind,
      level: result.level
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

  // Out of retries. Fall back *towards a human* rather than leaving the ticket
  // invisible: normalising an empty answer yields (other, problem) -> level 3,
  // team contact, so it surfaces in the queue as needing action. The metadata
  // says it was not actually judged, so a fallback is never read as a verdict.
  const fallback = normaliseCategorisation({});
  await store.updateTicket(ticket.id, {
    category: fallback.category,
    request_kind: fallback.request_kind,
    secondary_category: null,
    secondary_request_kind: null,
    level: fallback.level,
    responsible_team: fallback.responsible_team,
    metadata: mergeMetadata(ticket.metadata, {
      attempts,
      failed: true,
      last_error: error.message,
      reason: 'categorisation failed, routed to a human',
      at: new Date().toISOString()
    })
  });
  counts.failed += 1;
  counts.fallbacks += 1;
  logger?.error?.('categorise.fallback', { ticketId: ticket.id, attempts });
}

function attemptsSoFar(metadata) {
  const attempts = metadata?.categorisation?.attempts;
  return Number.isInteger(attempts) ? attempts : 0;
}

// metadata is a single jsonb column shared with anything else that annotates a
// ticket, so patch the `categorisation` key rather than replacing the object.
function mergeMetadata(metadata, categorisation) {
  const base = metadata && typeof metadata === 'object' ? metadata : {};
  return { ...base, categorisation: { ...base.categorisation, ...categorisation } };
}

export function createSupabaseCategoriserStore(supabase) {
  return {
    async findUncategorisedTickets(shopId, limit) {
      return supabaseSelect(
        supabase,
        'tickets',
        {
          shop_id: shopId,
          status: 'open',
          category: { operator: 'is', value: 'null' },
          deleted_at: { operator: 'is', value: 'null' },
          archived_at: { operator: 'is', value: 'null' }
        },
        'id,subject,metadata',
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

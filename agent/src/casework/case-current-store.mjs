import { supabaseSelect, supabaseSelectAll, supabaseUpsert } from '../../../scripts/lib/supabase-rest-client.mjs';
import { T } from '../../../scripts/lib/tables.mjs';

import { foldCase, nextVersion } from './case-fold.mjs';

// Keeps `case_current` folded: one row per ticket, rewritten when the ticket
// has moved since its last fold. Stage 4 of codex_plans/Case_State_Plan.md.
//
// NO MODEL AND NO TICKET WRITE. It reads messages, readings and case files and
// writes only `case_current`; nothing reads `next_actor` to change a status yet.

/** Tickets whose fold is missing or older than their latest message, case file or reading. */
export function staleTickets({ tickets = [], current = [], readings = [] }) {
  const folded = new Map(current.map((row) => [row.ticket_id, Date.parse(row.folded_at)]));
  const lastReading = new Map();
  for (const row of readings) {
    const at = Date.parse(row.read_at);
    if (!(lastReading.get(row.ticket_id) > at)) lastReading.set(row.ticket_id, at);
  }
  return tickets
    .filter((ticket) => {
      const at = folded.get(ticket.id);
      if (at === undefined || Number.isNaN(at)) return true;
      const moved = Math.max(
        Date.parse(ticket.last_message_at ?? '') || 0,
        Date.parse(ticket.investigated_at ?? '') || 0,
        lastReading.get(ticket.id) ?? 0
      );
      return moved > at;
    })
    .map((ticket) => ticket.id);
}

export function createCaseCurrentStore(supabase, { shopId }) {
  return {
    async staleTicketIds(limit) {
      const [tickets, current, readings] = await Promise.all([
        supabaseSelectAll(supabase, T.TICKETS, { shop_id: shopId, deleted_at: { operator: 'is', value: 'null' } }, 'id,last_message_at,investigated_at'),
        // Keyed by ticket, with no `id` column for the default paging order.
        supabaseSelectAll(supabase, T.CASE_CURRENT, { shop_id: shopId }, 'ticket_id,folded_at', { order: 'ticket_id.asc' }),
        supabaseSelectAll(supabase, T.TICKET_CASE_STATE, { shop_id: shopId }, 'ticket_id,read_at')
      ]);
      return staleTickets({ tickets, current, readings }).slice(0, limit);
    },

    async inputs(ticketId) {
      const [messages, caseFiles, readings, previous] = await Promise.all([
        supabaseSelectAll(supabase, T.TICKET_MESSAGES, { ticket_id: ticketId }, 'id,direction,actor,from_email,received_at,sent_at'),
        supabaseSelect(supabase, T.TICKET_INVESTIGATIONS, { ticket_id: ticketId }, 'trigger_message_id,verdict,missing'),
        supabaseSelect(supabase, T.TICKET_CASE_STATE, { ticket_id: ticketId }, 'trigger_message_id,pending_customer_inputs,commitments,contradictions'),
        supabaseSelect(supabase, T.CASE_CURRENT, { ticket_id: ticketId }, 'version,material_hash')
      ]);
      return { messages, caseFiles, readings, previous: previous[0] ?? null };
    },

    async save(row) {
      await supabaseUpsert(supabase, T.CASE_CURRENT, [row], 'ticket_id');
    }
  };
}

/**
 * Folds up to `limit` stale tickets. A ticket that fails is logged and left for
 * the next poll; the rest carry on.
 *
 * @param actorFor message → actor, for rows stored before the actor column
 */
export async function runFold({ store, shopId, actorFor, limit = 200, logger, now = () => new Date() }) {
  const totals = { considered: 0, folded: 0, versionsRaised: 0, failed: 0 };
  const ids = await store.staleTicketIds(limit);
  for (const ticketId of ids) {
    totals.considered += 1;
    try {
      const { messages, caseFiles, readings, previous } = await store.inputs(ticketId);
      const state = foldCase({ messages, caseFiles, readings, actorFor: (m) => m.actor ?? actorFor(m) });
      const version = nextVersion(previous, state);
      if (previous && version !== previous.version) totals.versionsRaised += 1;
      await store.save({ ticket_id: ticketId, shop_id: shopId, version, ...state, folded_at: now().toISOString() });
      totals.folded += 1;
    } catch (error) {
      totals.failed += 1;
      logger?.warn?.('fold.ticket_failed', { ticketId, message: error.message });
    }
  }
  return totals;
}

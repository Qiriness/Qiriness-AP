import { supabaseSelect, supabaseSelectAll, supabaseUpsert } from '../../../scripts/lib/supabase-rest-client.mjs';
import { T } from '../../../scripts/lib/tables.mjs';
import { days, toParameterMap } from '../../../scripts/lib/parameters.mjs';
import { createTicketRecord } from '../../../scripts/lib/ticket-record.mjs';
import { createDraftRecord } from '../../../scripts/lib/draft-record.mjs';

import { foldCase, nextVersion } from './case-fold.mjs';
import { caseStatusRecord, statusFromCase } from './case-status.mjs';

// Keeps `case_current` folded: one row per ticket, rewritten when the ticket
// has moved since its last fold. Stage 4 of codex_plans/Case_State_Plan.md.
//
// NO MODEL. It reads messages, readings and case files and writes `case_current`.
// Since stage 5c it also moves the ticket's status to what `next_actor` asks for
// (case-status.mjs), unless AGENT_CASE_STATUS_BY_NEXT_ACTOR is `off`.

/** Tickets whose fold is missing or older than their latest message, case file or reading. */
export function staleTickets({ tickets = [], current = [], readings = [], actions = [] }) {
  const folded = new Map(current.map((row) => [row.ticket_id, Date.parse(row.folded_at)]));
  const lastReading = new Map();
  for (const row of [...readings, ...actions.map((a) => ({ ticket_id: a.ticket_id, read_at: a.acted_at }))]) {
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

/** What the status rule reads off the ticket. */
const TICKET_FOR_STATUS = 'id,status,resolved_at,level,deleted_at,archived_at,needs_categorisation,needs_investigation,metadata';

export function createCaseCurrentStore(supabase, { shopId }) {
  const record = createTicketRecord(supabase, { shopId });
  const drafts = createDraftRecord(supabase, { shopId });
  return {
    async staleTicketIds(limit, { all = false } = {}) {
      const [tickets, current, readings, actions] = await Promise.all([
        supabaseSelectAll(supabase, T.TICKETS, { shop_id: shopId, deleted_at: { operator: 'is', value: 'null' } }, 'id,last_message_at,investigated_at'),
        // Keyed by ticket, with no `id` column for the default paging order.
        supabaseSelectAll(supabase, T.CASE_CURRENT, { shop_id: shopId }, 'ticket_id,folded_at', { order: 'ticket_id.asc' }),
        supabaseSelectAll(supabase, T.TICKET_CASE_STATE, { shop_id: shopId }, 'ticket_id,read_at'),
        supabaseSelectAll(supabase, T.TICKET_CASE_ACTIONS, { shop_id: shopId }, 'ticket_id,acted_at')
      ]);
      // `all`: every ticket, for after a change to the fold's own rules.
      const ids = all ? tickets.map((ticket) => ticket.id) : staleTickets({ tickets, current, readings, actions });
      return ids.slice(0, limit);
    },

    async inputs(ticketId) {
      const [messages, caseFiles, readings, previous, actions] = await Promise.all([
        supabaseSelectAll(supabase, T.TICKET_MESSAGES, { ticket_id: ticketId }, 'id,direction,actor,from_email,received_at,sent_at'),
        supabaseSelect(
          supabase,
          T.TICKET_INVESTIGATIONS,
          { ticket_id: ticketId },
          'trigger_message_id,verdict,missing,investigated_at,check_sequences:exemplar_match->policy->check_sequences'
        ),
        supabaseSelect(
          supabase,
          T.TICKET_CASE_STATE,
          { ticket_id: ticketId },
          'trigger_message_id,pending_customer_inputs,resolved_inputs,commitments,contradictions,effect,asked,obligations_opened,obligations_cleared'
        ),
        supabaseSelect(supabase, T.CASE_CURRENT, { ticket_id: ticketId }, 'version,material_hash,as_of_message_id'),
        supabaseSelect(supabase, T.TICKET_CASE_ACTIONS, { ticket_id: ticketId }, 'obligation_id,action,acted_by,acted_at')
      ]);
      return { messages, caseFiles, readings, previous: previous[0] ?? null, actions };
    },

    /** The holding interval, in working days, or null when the shop has not set it. */
    async holdingDays() {
      const rows = await supabaseSelect(supabase, T.SUPPORT_PARAMETERS, { shop_id: shopId }, 'parameter_key,value');
      return days(toParameterMap(rows), 'holding_reply_interval_days');
    },

    async save(row) {
      await supabaseUpsert(supabase, T.CASE_CURRENT, [row], 'ticket_id');
    },

    async ticket(ticketId) {
      const rows = await supabaseSelect(supabase, T.TICKETS, { id: ticketId, shop_id: shopId }, TICKET_FOR_STATUS);
      return rows[0] ?? null;
    },

    /** Null when the ticket changed status since it was read. */
    async setStatus(ticket, status, caseStatus, at) {
      return record.setCaseStatus(ticket, status, caseStatus, at);
    },

    /** Stage 6: drafts written for a case that has since moved. */
    async staleDrafts(ticketId, { version = null, reason = 'case_changed', outboundAt = null }) {
      let count = 0;
      if (outboundAt) count += await drafts.markSuperseded(ticketId, { before: outboundAt });
      if (version !== null) count += await drafts.markStale(ticketId, { version, reason });
      return count;
    }
  };
}

/**
 * Folds up to `limit` stale tickets. A ticket that fails is logged and left for
 * the next poll; the rest carry on.
 *
 * @param actorFor message → actor, for rows stored before the actor column
 * @param statusMap next_actor → statuses (`parseCaseStatusMap`); null leaves statuses alone
 * @param keepOpenLevels levels the fold never resolves
 */
export async function runFold({
  store,
  shopId,
  actorFor,
  limit = 200,
  all = false,
  ticketIds = null,
  statusMap = null,
  keepOpenLevels = [],
  logger,
  now = () => new Date()
}) {
  const totals = { considered: 0, folded: 0, versionsRaised: 0, statusesMoved: 0, draftsStaled: 0, failed: 0 };
  // `ticketIds`: fold exactly these, now (the dashboard, after a person acts).
  const ids = ticketIds ?? (await store.staleTicketIds(limit, { all }));
  const holdingDays = ids.length > 0 && store.holdingDays ? await store.holdingDays() : null;
  for (const ticketId of ids) {
    totals.considered += 1;
    try {
      const { messages, caseFiles, readings, previous, actions } = await store.inputs(ticketId);
      const state = foldCase({ messages, caseFiles, readings, actions, holdingDays, actorFor: (m) => m.actor ?? actorFor(m) });
      const version = nextVersion(previous, state);
      if (previous && version !== previous.version) totals.versionsRaised += 1;
      const at = now().toISOString();
      await store.save({ ticket_id: ticketId, shop_id: shopId, version, ...state, folded_at: at });
      totals.folded += 1;

      // STAGE 6: A DRAFT WRITTEN FOR A CASE THAT HAS MOVED GOES STALE. Our own
      // reply supersedes every open draft written before it, whether or not it
      // moved the version (Q13, Q14); a raised version stales the rest. Only once
      // a previous fold exists: a first fold has nothing to compare with.
      if (previous && store.staleDrafts) {
        const ourNewReply = state.last_actor === 'support' && state.as_of_message_id !== previous.as_of_message_id;
        const raised = version !== previous.version;
        if (ourNewReply || raised) {
          const staled = await store.staleDrafts(ticketId, {
            outboundAt: ourNewReply ? state.as_of_at : null,
            version: raised ? version : null,
            reason: ourNewReply ? 'superseded_by_outbound' : 'case_changed'
          });
          if (staled > 0) {
            totals.draftsStaled += staled;
            logger?.info?.('fold.drafts_staled', { ticketId, staled, version, ourNewReply });
          }
        }
      }

      if (statusMap && store.ticket) {
        const ticket = await store.ticket(ticketId);
        const { status } = statusFromCase(ticket, { ...state, version }, { map: statusMap, keepOpenLevels });
        if (status) {
          const moved = await store.setStatus(ticket, status, caseStatusRecord({ status, state: { ...state, version }, from: ticket.status, at }), at);
          if (moved) {
            totals.statusesMoved += 1;
            logger?.info?.('fold.status_moved', { ticketId, from: ticket.status, to: status, nextActor: state.next_actor });
          }
        }
      }
    } catch (error) {
      totals.failed += 1;
      logger?.warn?.('fold.ticket_failed', { ticketId, message: error.message });
    }
  }
  return totals;
}

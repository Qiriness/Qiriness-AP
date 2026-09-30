import { supabaseSelect, supabaseSelectAll, supabaseUpsert } from '../../../scripts/lib/supabase-rest-client.mjs';
import { T } from '../../../scripts/lib/tables.mjs';
import { days, toParameterMap } from '../../../scripts/lib/parameters.mjs';
import { createTicketRecord } from '../../../scripts/lib/ticket-record.mjs';
import { createDraftRecord } from '../../../scripts/lib/draft-record.mjs';
import { createSnoozeRecord, snoozeRow } from '../../../scripts/lib/snooze-record.mjs';

import { foldCase, nextVersion } from './case-fold.mjs';
import { caseStatusRecord, statusFromCase } from './case-status.mjs';
import { snoozeDecision } from './snooze-rule.mjs';
import { overridesOf } from '../../../scripts/lib/ticket-overrides.mjs';

// Keeps `case_current` folded: one row per ticket, rewritten when the ticket
// has moved since its last fold. Stage 4 of codex_plans/Case_State_Plan.md.
//
// NO MODEL. It reads messages, readings and case files and writes `case_current`.
// Since stage 5c it also moves the ticket's status to what `next_actor` asks for
// (case-status.mjs), unless AGENT_CASE_STATUS_BY_NEXT_ACTOR is `off`. With
// AGENT_AUTO_SNOOZE on, it snoozes a case our sent reply left waiting on someone
// else, and wakes one that came back to us (snooze-rule.mjs).

/** Tickets whose fold is missing or older than their latest message, case file or reading. */
export function staleTickets({ tickets = [], current = [], readings = [], actions = [] }) {
  const folded = new Map(current.map((row) => [row.ticket_id, Date.parse(row.folded_at)]));
  const lastReading = new Map();
  // A person's correction counts as an event: the dashboard re-folds at once, and
  // this catches the case where that re-fold failed.
  const corrections = tickets.flatMap((ticket) =>
    Object.values(overridesOf(ticket)).map((entry) => ({ ticket_id: ticket.id, read_at: entry?.set_at ?? null }))
  );
  for (const row of [...readings, ...actions.map((a) => ({ ticket_id: a.ticket_id, read_at: a.acted_at })), ...corrections]) {
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
const TICKET_FOR_STATUS = 'id,status,resolved_at,level,deleted_at,archived_at,needs_categorisation,needs_investigation,metadata,overrides';

export function createCaseCurrentStore(supabase, { shopId }) {
  const record = createTicketRecord(supabase, { shopId });
  const drafts = createDraftRecord(supabase, { shopId });
  const snoozes = createSnoozeRecord(supabase, { shopId });
  const parameterMap = async () =>
    toParameterMap(await supabaseSelect(supabase, T.SUPPORT_PARAMETERS, { shop_id: shopId }, 'parameter_key,value'));
  return {
    async staleTicketIds(limit, { all = false } = {}) {
      const [tickets, current, readings, actions] = await Promise.all([
        supabaseSelectAll(supabase, T.TICKETS, { shop_id: shopId, deleted_at: { operator: 'is', value: 'null' } }, 'id,last_message_at,investigated_at,overrides'),
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
      const [messages, caseFiles, readings, previous, actions, ticketRows] = await Promise.all([
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
        supabaseSelect(supabase, T.CASE_CURRENT, { ticket_id: ticketId }, 'version,material_hash,as_of_message_id,next_actor'),
        supabaseSelect(supabase, T.TICKET_CASE_ACTIONS, { ticket_id: ticketId }, 'obligation_id,action,acted_by,acted_at'),
        supabaseSelect(supabase, T.TICKETS, { id: ticketId, shop_id: shopId }, 'overrides')
      ]);
      return { messages, caseFiles, readings, previous: previous[0] ?? null, actions, overrides: overridesOf(ticketRows[0]) };
    },

    /** The holding interval, in working days, or null when the shop has not set it. */
    async holdingDays() {
      return days(await parameterMap(), 'holding_reply_interval_days');
    },

    /** The shop's parameters: the snooze deadlines are read from them. */
    parameters: parameterMap,

    snoozes: {
      open: (ticketId) => snoozes.open(ticketId),
      autoSnoozedOn: (ticketId, messageId) => snoozes.autoSnoozedOn(ticketId, messageId),
      snooze: (row) => snoozes.snooze(row),
      wake: (ticketId, reason, options) => snoozes.wake(ticketId, reason, options)
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
 * @param autoSnooze snooze a case our sent reply left waiting, wake one that came back (AGENT_AUTO_SNOOZE)
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
  autoSnooze = false,
  logger,
  now = () => new Date()
}) {
  const totals = { considered: 0, folded: 0, versionsRaised: 0, statusesMoved: 0, draftsStaled: 0, snoozed: 0, woken: 0, failed: 0 };
  // `ticketIds`: fold exactly these, now (the dashboard, after a person acts).
  const ids = ticketIds ?? (await store.staleTicketIds(limit, { all }));
  const holdingDays = ids.length > 0 && store.holdingDays ? await store.holdingDays() : null;
  const snoozing = autoSnooze && ids.length > 0 && store.snoozes && store.ticket;
  const parameters = snoozing && store.parameters ? await store.parameters() : new Map();
  for (const ticketId of ids) {
    totals.considered += 1;
    try {
      const { messages, caseFiles, readings, previous, actions, overrides = null } = await store.inputs(ticketId);
      const actorOfMessage = (m) => m.actor ?? actorFor(m);
      const state = foldCase({ messages, caseFiles, readings, actions, overrides, holdingDays, actorFor: actorOfMessage });
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

      let ticket = (statusMap || snoozing) && store.ticket ? await store.ticket(ticketId) : null;
      const lastCustomerAt = lastCustomerMessageAt(messages, actorOfMessage);
      if (statusMap && ticket) {
        const { status } = statusFromCase(ticket, { ...state, version }, { map: statusMap, keepOpenLevels, lastCustomerAt });
        if (status) {
          const moved = await store.setStatus(ticket, status, caseStatusRecord({ status, state: { ...state, version }, from: ticket.status, at }), at);
          if (moved) {
            totals.statusesMoved += 1;
            logger?.info?.('fold.status_moved', { ticketId, from: ticket.status, to: status, nextActor: state.next_actor });
            ticket = { ...ticket, status };
          }
        }
      }

      // SNOOZE, after the status: the rule reads the status the case now has.
      if (snoozing && ticket) {
        const openSnooze = await store.snoozes.open(ticketId);
        const alreadySnoozedOn = openSnooze ? false : await store.snoozes.autoSnoozedOn(ticketId, state.as_of_message_id);
        const decision = snoozeDecision({
          ticket,
          state: { ...state, version },
          previous,
          openSnooze,
          alreadySnoozedOn,
          parameters,
          lastCustomerAt,
          keepOpenLevels,
          now: new Date(at)
        });
        if (decision.action === 'snooze') {
          const { row, error } = snoozeRow({
            ticketId,
            source: 'auto',
            waitingFor: decision.waitingFor,
            wakeAt: decision.wakeAt,
            reason: 'after_our_reply',
            triggerMessageId: decision.triggerMessageId,
            caseVersion: version,
            snoozedBy: 'agent',
            now: new Date(at)
          });
          if (row && (await store.snoozes.snooze(row)).created) {
            totals.snoozed += 1;
            logger?.info?.('fold.snoozed', { ticketId, waitingFor: decision.waitingFor, wakeAt: row.wake_at });
          } else if (error) {
            logger?.warn?.('fold.snooze_refused', { ticketId, error });
          }
        } else if (decision.action === 'wake') {
          if (await store.snoozes.wake(ticketId, decision.reason, { wokenBy: 'agent', at: new Date(at) })) {
            totals.woken += 1;
            logger?.info?.('fold.woken', { ticketId, reason: decision.reason, nextActor: state.next_actor });
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

/** When the customer last wrote, or null: a person's status holds until then. */
export function lastCustomerMessageAt(messages = [], actorFor) {
  let latest = null;
  for (const message of messages) {
    if (actorFor(message) !== 'customer') continue;
    const at = message.received_at ?? message.sent_at ?? null;
    if (at && (!latest || Date.parse(at) > Date.parse(latest))) latest = at;
  }
  return latest;
}

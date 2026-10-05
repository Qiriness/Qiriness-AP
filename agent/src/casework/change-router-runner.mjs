import { supabaseSelect, supabaseSelectAll, supabaseUpdateById } from '../../../scripts/lib/supabase-rest-client.mjs';
import { T } from '../../../scripts/lib/tables.mjs';
import { days, toParameterMap } from '../../../scripts/lib/parameters.mjs';
import { reinvestigationColumns } from '../../../scripts/lib/order-link.mjs';

import { answerFromRow } from '../investigation/answer-selection.mjs';
import { answerSetFor } from '../investigation/investigation-rules.mjs';
import { orderStatesAt } from '../investigation/order-states-at.mjs';
import { ROUTED_STATUSES, driftDiffers, factDrift, noticeDue, noticeRecord, routeChange } from './change-router.mjs';

// The `route` stage: every open or person-held ticket we owe a reply on, with a built order
// bundle, asked whether what moved under its case file changes anything
// (change-router.mjs). After `context`, so it reads the bundle that pass just
// rebuilt; before `investigate`, so a re-investigation it queues runs in the
// same poll.
//
// THE QUEUE IS DERIVED, NOT FLAGGED, like every other stage: open or
// awaiting_human, an order, a
// bundle, no pass pending. It is small by construction (18 tickets on
// 2026-10-04), and a ticket whose drift is already recorded writes nothing.
//
// WHAT IT WRITES. `tickets.fact_drift`, always, so the fold raises the version
// (drafts go stale, an approval written for the old facts is refused at send).
// On `reinvestigate`, also `needs_investigation` and a `change_router` trail
// whose `at` becomes the investigation's clock (investigation-runner.mjs).
//
// AND, FIRST, THE REFUND NOTICE (DECISIONS § Refund notice): a refund recorded in
// Shopify that no message of ours has reported, on a ticket in the marked rule's
// answer set, whatever its status. It records `fact_drift.notice` (the fold keeps
// the case on us until we have written) and reopens a closed or resolved ticket
// to `awaiting_human`, so the notice the drafting pass writes is in front of a
// person. First, so the state pass below reads the drift it may have written.

const TICKET_COLUMNS =
  'id,status,needs_investigation,needs_categorisation,shopify_order_number,resolved_context,fact_drift,metadata,investigated_at';

const NOTICE_TICKET_COLUMNS =
  'id,status,category,secondary_category,shopify_order_number,fact_drift,metadata,first_message_at,last_message_at,case_id';

/** A notice never reopens these: a spam thread, or one handed to a team. */
const NEVER_NOTICED = ['spam', 'forwarded'];

/** Statuses a notice reopens, so the draft is in front of a person. */
const REOPENED_BY_NOTICE = ['closed', 'resolved'];

const INVESTIGATION_COLUMNS =
  'ticket_id,investigated_at,context_ref,tool_calls,established,findings_trace,exemplar_match';

/** Ids per `in.()` request: the list travels in the URL (the HTTP 414 of 2026-09-27). */
const ID_BATCH = 100;

export function createChangeRouterStore(supabase, { shopId }) {
  const answerCache = new Map();
  const inBatches = async (table, column, ids, columns, options) => {
    const pages = [];
    for (let index = 0; index < ids.length; index += ID_BATCH) {
      const batch = ids.slice(index, index + ID_BATCH);
      pages.push(
        supabaseSelectAll(supabase, table, { shop_id: shopId, [column]: { operator: 'in', value: `(${batch.join(',')})` } }, columns, options)
      );
    }
    return (await Promise.all(pages)).flat();
  };

  return {
    async candidates() {
      return supabaseSelectAll(
        supabase,
        T.TICKETS,
        {
          shop_id: shopId,
          status: { operator: 'in', value: `(${ROUTED_STATUSES.join(',')})` },
          deleted_at: { operator: 'is', value: 'null' },
          archived_at: { operator: 'is', value: 'null' },
          shopify_order_number: { operator: 'not.is', value: 'null' },
          context_resolved_at: { operator: 'not.is', value: 'null' },
          needs_investigation: false,
          needs_categorisation: false
        },
        TICKET_COLUMNS
      );
    },

    /** `Map(ticket_id → next_actor)`. */
    async nextActors(ticketIds) {
      if (ticketIds.length === 0) return new Map();
      const rows = await inBatches(T.CASE_CURRENT, 'ticket_id', ticketIds, 'ticket_id,next_actor', { order: 'ticket_id.asc' });
      return new Map(rows.map((row) => [row.ticket_id, row.next_actor]));
    },

    /** The newest case file per ticket. */
    async latestInvestigations(ticketIds) {
      if (ticketIds.length === 0) return new Map();
      const rows = await inBatches(T.TICKET_INVESTIGATIONS, 'ticket_id', ticketIds, INVESTIGATION_COLUMNS);
      const latest = new Map();
      for (const row of rows) {
        const held = latest.get(row.ticket_id);
        if (!held || Date.parse(row.investigated_at ?? '') > Date.parse(held.investigated_at ?? '')) latest.set(row.ticket_id, row);
      }
      return latest;
    },

    /** Approved rules of one set, as the investigation loads them. Cached for the pass. */
    async answers(answerSet) {
      if (!answerCache.has(answerSet)) {
        const rows = await supabaseSelect(
          supabase,
          T.SUPPORT_ANSWERS,
          { shop_id: shopId, answer_set: answerSet, approval_status: 'approved', deleted_at: { operator: 'is', value: 'null' } },
          'id,answer_key,situation_key,when_conditions,priority,is_fallback'
        );
        answerCache.set(answerSet, (rows || []).map(answerFromRow));
      }
      return answerCache.get(answerSet);
    },

    /** Throws on failure: without the shop's windows every time state reads `unknown`. */
    async parameters() {
      return toParameterMap(await supabaseSelect(supabase, T.SUPPORT_PARAMETERS, { shop_id: shopId }, 'parameter_key,value'));
    },

    /** The rules marked as the template for a notice, by answer set. */
    async noticeTemplates() {
      const rows = await supabaseSelect(
        supabase,
        T.SUPPORT_ANSWERS,
        {
          shop_id: shopId,
          notify_on: 'refund_recorded',
          approval_status: 'approved',
          deleted_at: { operator: 'is', value: 'null' }
        },
        'answer_set,answer_key'
      );
      return new Map((rows || []).map((row) => [row.answer_set, row]));
    },

    /** Live tickets with an order, any status a notice may concern. */
    async noticeCandidates() {
      return supabaseSelectAll(
        supabase,
        T.TICKETS,
        {
          shop_id: shopId,
          status: { operator: 'not.in', value: `(${NEVER_NOTICED.join(',')})` },
          deleted_at: { operator: 'is', value: 'null' },
          archived_at: { operator: 'is', value: 'null' },
          shopify_order_number: { operator: 'not.is', value: 'null' }
        },
        NOTICE_TICKET_COLUMNS
      );
    },

    /** `Map(order name → refunds)`, for the orders that have any. */
    async refundsByOrder(orderNames) {
      const names = [...new Set(orderNames.filter(Boolean))];
      const byName = new Map();
      for (let index = 0; index < names.length; index += ID_BATCH) {
        const batch = names.slice(index, index + ID_BATCH);
        const rows = await supabaseSelectAll(
          supabase,
          T.ORDERS,
          {
            shop_id: shopId,
            name: { operator: 'in', value: `(${batch.map((name) => `"${String(name).replace(/"/g, '\\"')}"`).join(',')})` },
            deleted_at: { operator: 'is', value: 'null' }
          },
          'name,refunds'
        );
        for (const row of rows) if (Array.isArray(row.refunds) && row.refunds.length > 0) byName.set(row.name, row.refunds);
      }
      return byName;
    },

    /**
     * Our last message on each case, across every thread of it: a reply on a
     * sibling thread told the customer as surely as one on this thread.
     */
    async lastOutboundByCase(caseIds) {
      if (caseIds.length === 0) return new Map();
      const threads = await inBatches(T.TICKETS, 'case_id', caseIds, 'id,case_id');
      const caseOf = new Map(threads.map((row) => [row.id, row.case_id]));
      const sent = await inBatches(T.TICKET_MESSAGES, 'ticket_id', [...caseOf.keys()], 'ticket_id,direction,sent_at,received_at');
      const last = new Map();
      for (const row of sent) {
        if (row.direction !== 'outbound') continue;
        const at = row.sent_at ?? row.received_at;
        const caseId = caseOf.get(row.ticket_id);
        if (at && (!last.has(caseId) || Date.parse(at) > Date.parse(last.get(caseId)))) last.set(caseId, at);
      }
      return last;
    },

    async write(ticketId, columns) {
      await supabaseUpdateById(supabase, T.TICKETS, ticketId, columns);
    }
  };
}

/** The answer sets a case file's selection names: its own, and each request's. */
function answerSetsOf(investigation) {
  const policy = investigation?.exemplar_match?.policy;
  if (!policy) return [];
  const sets = [policy.answer_set, ...(Array.isArray(policy.per_request) ? policy.per_request.map((r) => r.answer_set) : [])];
  return [...new Set(sets.filter(Boolean))];
}

/**
 * @param dryRun   decide and report, write nothing
 * @param onResult `({ ticket, result, written })` per ticket, for the CLI
 */
export async function runChangeRouter({ store, shopId, logger, now = new Date(), dryRun = false, onResult = null, onNotice = null }) {
  const totals = { considered: 0, none: 0, redraft: 0, reinvestigate: 0, already_recorded: 0, written: 0, failed: 0 };

  let parameters;
  try {
    parameters = await store.parameters();
  } catch (error) {
    // NOT `new Map()`: every time state would read `unknown` and look moved.
    logger?.warn?.('route.parameters_load_failed', { shopId, reason: error.message });
    return { ...totals, skipped: 'parameters_unavailable' };
  }

  totals.notices = await runNotices({ store, shopId, logger, parameters, now, dryRun, onNotice });

  const tickets = await store.candidates();
  if (tickets.length === 0) return totals;

  const ids = tickets.map((ticket) => ticket.id);
  const [actors, investigations] = await Promise.all([store.nextActors(ids), store.latestInvestigations(ids)]);
  const at = new Date(now).toISOString();

  for (const ticket of tickets) {
    totals.considered += 1;
    try {
      const investigation = investigations.get(ticket.id) ?? null;
      const answersBySet = new Map();
      for (const set of answerSetsOf(investigation)) answersBySet.set(set, await store.answers(set));

      const result = routeChange({
        ticket,
        caseCurrent: actors.has(ticket.id) ? { next_actor: actors.get(ticket.id) } : null,
        investigation,
        // THE ROUTER'S CLOCK IS NOW, for open tickets we owe a reply on: the
        // reply goes out today, so it must describe today (DECISIONS § Change
        // router, amending § The clock is the customer's message).
        statesNow: ticket.resolved_context?.order ? orderStatesAt(ticket.resolved_context, parameters, new Date(now)) : null,
        answersBySet
      });
      totals[result.outcome] += 1;

      if (result.outcome === 'none') {
        onResult?.({ ticket, result, written: false });
        continue;
      }

      const drift = factDrift({ ...result, investigation, at });
      if (!driftDiffers(ticket.fact_drift, drift)) {
        totals.already_recorded += 1;
        onResult?.({ ticket, result, written: false });
        continue;
      }

      // A recorded notice survives a state drift written over it.
      const columns = { fact_drift: ticket.fact_drift?.notice ? { ...drift, notice: ticket.fact_drift.notice } : drift };
      if (result.outcome === 'reinvestigate') {
        Object.assign(columns, reinvestigationColumns(ticket), {
          metadata: {
            ...(ticket.metadata && typeof ticket.metadata === 'object' ? ticket.metadata : {}),
            change_router: { at, outcome: result.outcome, reason: result.reason, changed: result.changed }
          }
        });
      }
      if (!dryRun) {
        await store.write(ticket.id, columns);
        totals.written += 1;
      }
      logger?.info?.('route.changed', { shopId, ticketId: ticket.id, outcome: result.outcome, reason: result.reason, states: Object.keys(result.changed) });
      onResult?.({ ticket, result, written: !dryRun });
    } catch (error) {
      totals.failed += 1;
      logger?.warn?.('route.ticket_failed', { shopId, ticketId: ticket.id, reason: error.message });
    }
  }

  return totals;
}

/**
 * The refund-notice pass. Optional on the store: one without the reads (a test,
 * a rehearsal) records no notices, which is the behaviour before they existed.
 */
async function runNotices({ store, shopId, logger, parameters, now, dryRun, onNotice }) {
  const totals = { considered: 0, due: 0, written: 0, reopened: 0, failed: 0 };
  if (!store.noticeTemplates) return totals;
  const windowDays = days(parameters, 'refund_notice_window_days');
  if (windowDays === null) return { ...totals, skipped: 'window_unset' };
  const templates = await store.noticeTemplates();
  if (templates.size === 0) return { ...totals, skipped: 'no_template' };

  const templateFor = (ticket) =>
    templates.get(answerSetFor(ticket.category)) ?? templates.get(answerSetFor(ticket.secondary_category)) ?? null;
  const inScope = (await store.noticeCandidates()).filter((ticket) => templateFor(ticket));
  if (inScope.length === 0) return totals;

  const [refunds, lastOutbound] = await Promise.all([
    store.refundsByOrder(inScope.map((ticket) => ticket.shopify_order_number)),
    store.lastOutboundByCase([...new Set(inScope.map((ticket) => ticket.case_id).filter(Boolean))])
  ]);

  // ONE NOTICE PER CASE: the thread the customer wrote on last.
  const byCase = new Map();
  for (const ticket of inScope) {
    if (!refunds.has(ticket.shopify_order_number)) continue;
    const key = ticket.case_id ?? ticket.id;
    const held = byCase.get(key);
    if (!held || Date.parse(ticket.last_message_at ?? '') > Date.parse(held.last_message_at ?? '')) byCase.set(key, ticket);
  }

  const at = new Date(now).toISOString();
  for (const ticket of byCase.values()) {
    totals.considered += 1;
    try {
      const template = templateFor(ticket);
      const due = noticeDue({
        inScope: true,
        refunds: refunds.get(ticket.shopify_order_number),
        firstMessageAt: ticket.first_message_at,
        lastMessageAt: ticket.last_message_at,
        lastOutboundAt: lastOutbound.get(ticket.case_id) ?? null,
        windowDays,
        recorded: ticket.fact_drift?.notice ?? null
      });
      if (!due) continue;
      totals.due += 1;

      const notice = noticeRecord({ refundIds: due.refund_ids, template, at });
      const columns = { fact_drift: { ...(ticket.fact_drift ?? {}), notice, checked_at: at } };
      const reopen = REOPENED_BY_NOTICE.includes(ticket.status);
      if (reopen) {
        // As ingestion reopens: off a terminal status clears both timestamps.
        Object.assign(columns, { status: 'awaiting_human', closed_at: null, resolved_at: null });
      }
      columns.metadata = {
        ...(ticket.metadata && typeof ticket.metadata === 'object' ? ticket.metadata : {}),
        change_router: { at, outcome: 'notice', reason: 'refund_notice', refund_ids: due.refund_ids, reopened_from: reopen ? ticket.status : null }
      };
      if (!dryRun) {
        await store.write(ticket.id, columns);
        totals.written += 1;
        if (reopen) totals.reopened += 1;
      }
      logger?.info?.('route.notice', { shopId, ticketId: ticket.id, refunds: due.refund_ids.length, reopened: reopen });
      onNotice?.({ ticket, notice, reopen, written: !dryRun });
    } catch (error) {
      totals.failed += 1;
      logger?.warn?.('route.notice_failed', { shopId, ticketId: ticket.id, reason: error.message });
    }
  }
  return totals;
}

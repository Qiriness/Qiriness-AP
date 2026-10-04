import { supabaseSelect, supabaseSelectAll, supabaseUpdateById } from '../../../scripts/lib/supabase-rest-client.mjs';
import { T } from '../../../scripts/lib/tables.mjs';
import { toParameterMap } from '../../../scripts/lib/parameters.mjs';
import { reinvestigationColumns } from '../../../scripts/lib/order-link.mjs';

import { answerFromRow } from '../investigation/answer-selection.mjs';
import { orderStatesAt } from '../investigation/order-states-at.mjs';
import { ROUTED_STATUSES, driftDiffers, factDrift, routeChange } from './change-router.mjs';

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

const TICKET_COLUMNS =
  'id,status,needs_investigation,needs_categorisation,shopify_order_number,resolved_context,fact_drift,metadata,investigated_at';

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
export async function runChangeRouter({ store, shopId, logger, now = new Date(), dryRun = false, onResult = null }) {
  const totals = { considered: 0, none: 0, redraft: 0, reinvestigate: 0, already_recorded: 0, written: 0, failed: 0 };

  const tickets = await store.candidates();
  if (tickets.length === 0) return totals;

  let parameters;
  try {
    parameters = await store.parameters();
  } catch (error) {
    // NOT `new Map()`: every time state would read `unknown` and look moved.
    logger?.warn?.('route.parameters_load_failed', { shopId, reason: error.message });
    return { ...totals, skipped: 'parameters_unavailable' };
  }

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

      const columns = { fact_drift: drift };
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

/**
 * Server-only assembly of the current facts consumed by ticket-priority.mjs.
 *
 * Business rules stay in the pure scorer. This module only reads the latest
 * situation, live synced order facts and UI parameters in bulk, with no message
 * bodies or customer records.
 */

import { loadConfig } from "../../../scripts/lib/sync-config.mjs";
import { days, text, toParameterMap } from "../../../scripts/lib/parameters.mjs";
import {
  createSupabaseClient,
  supabaseSelect,
  supabaseSelectAll,
} from "../../../scripts/lib/supabase-rest-client.mjs";
import { T } from "../../../scripts/lib/tables.mjs";
import { buildOrderContext, orderStates } from "../../../agent/src/resolution/order-context.mjs";
import { excessWorkingDays } from "../../../scripts/lib/working-days.mjs";

export type PriorityFacts = {
  situationKey: string | null;
  orderState: string;
  dispatchExcessWorkingDays: number | null;
  deliveryExcessWorkingDays: number | null;
  actionCompleted: boolean;
  // The `logistics_provider_name` parameter, named in the priority reasons.
  logisticsProvider: string | null;
};

export type PriorityRead = { at: Date; byTicket: Map<string, PriorityFacts> };

const DEFAULTS = Object.freeze({ dispatch: 3, franceDelivery: 3, abroadDelivery: 6 });

function getSupabaseClient() {
  return createSupabaseClient(loadConfig(process.env as Record<string, string | undefined>));
}

function chunks<T>(values: T[], size = 100): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function inFilter(values: unknown[]): { operator: string; value: string } {
  const escaped = values.map((value) => `"${String(value).replaceAll('"', '\\"')}"`);
  return { operator: "in", value: `(${escaped.join(",")})` };
}

/**
 * The two keys read out of `exemplar_match`, in the database: the blob is a
 * diagnostic record (closest, runner-up, margins, needs) and only these decide
 * the situation.
 */
const INVESTIGATION_SITUATION =
  "id,ticket_id,investigated_at," +
  "policy_situation_key:exemplar_match->policy->>situation_key,exemplar_key:exemplar_match->>exemplar_key";

function situationFromInvestigation(row: any): string | null {
  return row?.policy_situation_key ?? row?.exemplar_key ?? null;
}

/**
 * What the order states need: delivery, dispatch and cancellation, the dates and
 * the destination. Not the line items, refunds, returns or discounts that
 * `orderForContext` carries for the agent. Checked on 2026-10-06: the same
 * order state, dates and country for all 180 linked orders, 252 kB against 718.
 */
const ORDER_FOR_PRIORITY =
  "id,name,order_number,customer_id," +
  "financial_status,fulfillment_status,return_status,order_status," +
  "cancel_reason,cancelled_at,sales_channel,source_name," +
  "currency_code,subtotal_price,total_discounts,total_shipping_price," +
  "total_tax,total_price,total_refunded,total_outstanding," +
  "fulfillments,shipping_destination,customer_email_masked," +
  "delivered_at,return_refund_opened_at,return_refund_completed_at," +
  "processed_at,shopify_created_at,shopify_updated_at,tracking_numbers";

function newestByTicket(rows: any[], timestamp: string): Map<string, any> {
  const result = new Map<string, any>();
  for (const row of rows) {
    const current = result.get(row.ticket_id);
    if (!current || Date.parse(row[timestamp] ?? "") > Date.parse(current[timestamp] ?? "")) {
      result.set(row.ticket_id, row);
    }
  }
  return result;
}

async function selectForTicketChunks(
  table: string,
  shopId: string,
  ticketIds: string[],
  columns: string
): Promise<any[]> {
  const pages = await Promise.all(chunks(ticketIds).map((ids) =>
    supabaseSelectAll(
      getSupabaseClient(),
      table,
      { shop_id: shopId, ticket_id: inFilter(ids) },
      columns,
      { order: "id.asc" }
    )
  ));
  return pages.flat();
}

async function selectLinkedOrders(shopId: string, names: string[]): Promise<any[]> {
  const pages = await Promise.all(chunks(names).map((batch) =>
    supabaseSelectAll(
      getSupabaseClient(),
      T.ORDERS,
      { shop_id: shopId, name: inFilter(batch), deleted_at: { operator: "is", value: "null" } },
      ORDER_FOR_PRIORITY,
      { order: "id.asc" }
    )
  ));
  return pages.flat();
}

export async function loadTicketPriority(shopId: string, rows: any[]): Promise<PriorityRead> {
  const at = new Date();
  const ticketIds = rows.map((row) => String(row.id));
  const orderNames = [...new Set(rows.map((row) => row.shopify_order_number).filter(Boolean).map(String))];

  const [investigations, caseStates, orders, parameterRows] = await Promise.all([
    selectForTicketChunks(
      T.TICKET_INVESTIGATIONS,
      shopId,
      ticketIds,
      INVESTIGATION_SITUATION
    ),
    selectForTicketChunks(
      T.TICKET_CASE_STATE,
      shopId,
      ticketIds,
      "id,ticket_id,situation_key,read_at"
    ),
    selectLinkedOrders(shopId, orderNames),
    supabaseSelect(getSupabaseClient(), T.SUPPORT_PARAMETERS, { shop_id: shopId }, "parameter_key,value")
  ]);

  const parameters = toParameterMap(parameterRows);
  const thresholds = {
    dispatch: days(parameters, "dispatch_days") ?? DEFAULTS.dispatch,
    franceDelivery: days(parameters, "france_delivery_days") ?? DEFAULTS.franceDelivery,
    abroadDelivery: days(parameters, "abroad_delivery_days") ?? DEFAULTS.abroadDelivery
  };
  const logisticsProvider = text(parameters, "logistics_provider_name");
  const latestInvestigation = newestByTicket(investigations, "investigated_at");
  const latestCaseState = newestByTicket(caseStates, "read_at");
  const ordersByName = new Map(orders.map((order) => [String(order.name), order]));
  const byTicket = new Map<string, PriorityFacts>();

  for (const row of rows) {
    const investigation = latestInvestigation.get(row.id);
    const caseState = latestCaseState.get(row.id);
    const investigationAt = Date.parse(investigation?.investigated_at ?? "") || 0;
    const caseStateAt = Date.parse(caseState?.read_at ?? "") || 0;
    const situationKey = caseStateAt > investigationAt
      ? typeof caseState?.situation_key === "string" ? caseState.situation_key : null
      : situationFromInvestigation(investigation);

    const order = row.shopify_order_number ? ordersByName.get(String(row.shopify_order_number)) : null;
    const context = order ? buildOrderContext(order, null, { now: at }) : null;
    const states = (orderStates as any)(context, {
      dispatchDays: thresholds.dispatch,
      franceDeliveryDays: thresholds.franceDelivery,
      abroadDeliveryDays: thresholds.abroadDelivery,
      now: at
    });
    const orderState = states?.order_state ?? "unknown";
    const countryCode = String(context?.order?.shipTo?.countryCode ?? "").toUpperCase();
    const deliveryThreshold = countryCode === "FR"
      ? thresholds.franceDelivery
      : countryCode
        ? thresholds.abroadDelivery
        : Math.min(thresholds.franceDelivery, thresholds.abroadDelivery);
    byTicket.set(row.id, {
      situationKey,
      orderState,
      dispatchExcessWorkingDays: orderState === "not_dispatched"
        ? excessWorkingDays(context?.order?.placedAt, at, thresholds.dispatch)
        : 0,
      deliveryExcessWorkingDays: orderState === "dispatched"
        ? excessWorkingDays(context?.order?.delivery?.dispatchedAt, at, deliveryThreshold)
        : 0,
      actionCompleted: (row.case_status ?? row.status) === "resolved" || (row.case_status ?? row.status) === "closed",
      logisticsProvider
    });
  }

  return { at, byTicket: withCaseFacts(rows, byTicket, latestInvestigation) };
}

/**
 * A CASE IS RANKED ON ITS CURRENT SITUATION (61_cases.sql). The lead thread of
 * a case is often the newest one — « toujours rien » on a new thread — and may
 * not be investigated yet, or carry no order. Its situation and order facts
 * then come from the most recently investigated thread of the same case, so a
 * chase about a lost parcel is ranked as a lost parcel, not as a routine
 * question. A thread's own facts, when it has a situation, always win.
 */
export function withCaseFacts(
  rows: any[],
  byTicket: Map<string, PriorityFacts>,
  latestInvestigation: Map<string, any> = new Map()
): Map<string, PriorityFacts> {
  const byCase = new Map<string, any[]>();
  for (const row of rows) {
    if (!row.case_id) continue;
    const list = byCase.get(row.case_id) ?? [];
    list.push(row);
    byCase.set(row.case_id, list);
  }
  for (const threads of byCase.values()) {
    if (threads.length < 2) continue;
    const donor = threads
      .filter((row) => byTicket.get(row.id)?.situationKey)
      .sort(
        (a, b) =>
          (Date.parse(latestInvestigation.get(b.id)?.investigated_at ?? "") || 0) -
          (Date.parse(latestInvestigation.get(a.id)?.investigated_at ?? "") || 0)
      )[0];
    if (!donor) continue;
    const donated = byTicket.get(donor.id)!;
    for (const row of threads) {
      const own = byTicket.get(row.id);
      if (own?.situationKey) continue;
      byTicket.set(row.id, {
        ...donated,
        actionCompleted: (row.case_status ?? row.status) === "resolved" || (row.case_status ?? row.status) === "closed"
      });
    }
  }
  return byTicket;
}

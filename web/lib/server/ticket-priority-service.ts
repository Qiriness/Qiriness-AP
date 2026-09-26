/**
 * Server-only assembly of the current facts consumed by ticket-priority.mjs.
 *
 * Business rules stay in the pure scorer. This module only reads the latest
 * situation, live synced order facts and UI parameters in bulk, with no message
 * bodies or customer records.
 */

import { loadConfig } from "../../../scripts/lib/sync-config.mjs";
import { days, toParameterMap } from "../../../scripts/lib/parameters.mjs";
import {
  createSupabaseClient,
  supabaseSelect,
  supabaseSelectAll,
} from "../../../scripts/lib/supabase-rest-client.mjs";
import { COLUMNS, T } from "../../../scripts/lib/tables.mjs";
import { buildOrderContext, orderStates } from "../../../agent/src/resolution/order-context.mjs";
import { excessWorkingDays } from "../../../scripts/lib/working-days.mjs";

export type PriorityFacts = {
  situationKey: string | null;
  orderState: string;
  dispatchExcessWorkingDays: number | null;
  deliveryExcessWorkingDays: number | null;
  actionCompleted: boolean;
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

function situationFromInvestigation(row: any): string | null {
  const match = row?.exemplar_match;
  if (!match || typeof match !== "object") return null;
  const policy = match.policy && typeof match.policy === "object" ? match.policy : {};
  return typeof policy.situation_key === "string"
    ? policy.situation_key
    : typeof match.exemplar_key === "string"
      ? match.exemplar_key
      : null;
}

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
      COLUMNS.orderForContext,
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
      "id,ticket_id,exemplar_match,investigated_at"
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
      actionCompleted: row.status === "resolved" || row.status === "closed"
    });
  }

  return { at, byTicket };
}

/**
 * The Customers panel's reads.
 *
 * TWO DENOMINATORS, NEVER ONE. 53,942 of this shop's 58,201 customers have never
 * placed an order — they are newsletter signups and abandoned carts that Shopify
 * files as `PROSPECTS`. Any rate divided by 58,201 is therefore a statement about
 * the mailing list, not about customers: 929 VIPs is 1.6% of "customers" and 22%
 * of buyers, and only the second number is about anything. `CustomerPanel.base`
 * carries both counts for exactly that reason, and the view is expected to name
 * the denominator on every tile it draws.
 *
 * NO ROW-LEVEL READ OF TICKETS. `customer_ticket_facts` is one row per case that
 * resolved to a customer, and this service used to read all of it and group it
 * here, refusing to render at a 500-row cap. Case volume reached the cap, so the
 * figures are now aggregated in SQL (`customer_vip_ticket_stats`,
 * `customer_vip_ticket_categories`) and only the call list — the VIP cases that
 * are open and level 3+ — comes back as rows. See 86_customer_vip_aggregates.sql.
 *
 * VIP IS THE SHOP'S RULE, ASKED, NEVER RE-DERIVED. The thresholds are set on
 * this panel and stored on `shops`; `vip_customers()` applies them (spend AND
 * orders inside a window). This service asks it through `vip-rule.mjs`, as the
 * ticket queue and the agent do, so a customer badged VIP on a ticket is VIP
 * here and in the case file. Shopify's RFM segments are still shown, as
 * Shopify's, and decide nothing.
 *
 * Server-only; see ./shared.ts for the read rules this obeys.
 */

import { formatRfmGroup } from "../../../../scripts/lib/customer-segments.mjs";
import {
  describeVipRule,
  summariseVipRule,
  vipArgsFor,
} from "../../../../scripts/lib/vip-rule.mjs";
import { RPC, V } from "../../../../scripts/lib/tables.mjs";
import type {
  CustomerAtRisk,
  CustomerPanel,
  KnowledgeCategory,
  SegmentTotal,
  TicketHappiness,
  TicketLevel,
  TicketStatus,
} from "../../types";
import { CLOSED_STATUSES } from "../../ticket-stats";
import { callRpc, callRpcOne, count, getSupabaseClient, readView } from "./shared";
import { getVipRule } from "../vip-rule-cache";
import { logDashboardAccess } from "../access-log";

/**
 * Which levels land on the call list.
 *
 * 3 AND ABOVE, not 3 exactly. Level 4 is an escalation read from the mail itself
 * — a threat of legal action, a hospitalisation — and is strictly worse than the
 * level 3 beneath it. A "who to call today" list that filtered to `level === 3`
 * would drop precisely the ticket that most needs the phone call.
 */
const CALL_LIST_MIN_LEVEL = 3;

/**
 * Where "unhappy" starts on the 1-4 happiness scale: 3 is "Discontent", 4 is
 * "Really unhappy". 2 is neutral, and counting neutral customers as exposure
 * would inflate the exposed-spend tile past the point of being believed.
 */
const UNHAPPY_FROM = 3;

/** The shape `customer_ticket_facts` returns, before any coercion. */
interface TicketFactRow {
  ticket_id: string;
  category: string | null;
  level: number | string | null;
  happiness: number | string | null;
  status: string;
  first_message_at: string | null;
  customer_id: string;
  customer_display_name: string | null;
  rfm_group: string | null;
  number_of_orders: number | string | null;
  amount_spent: number | string | null;
  last_order_at: string | null;
  on_email_marketing_list: boolean | null;
  country_code: string | null;
}

interface TicketStatsRow {
  tickets_linked: number | string | null;
  vip_tickets: number | string | null;
  vip_contacted: number | string | null;
  spend_exposed: number | string | null;
}

export async function getCustomersPanel(shopId: string): Promise<CustomerPanel> {
  const supabase = getSupabaseClient();
  const rule = await getVipRule(shopId);
  // Biggest segment first, which on this shop means the panel opens on
  // PROSPECTS at 53,942 — the denominator problem stated by the data itself.
  const segmentsPromise = readView<Record<string, unknown>>(V.CUSTOMER_SEGMENT_TOTALS, shopId, {
    order: "customers.desc",
  });

  // THE SHOP'S RULE is applied in SQL (vip_customers); nothing here compares a
  // number. With no rule nobody is a VIP, so the three reads are skipped.
  const ticketReads = rule
    ? (async () => {
        const args = await vipArgsFor(supabase, shopId, rule);
        const closed = [...CLOSED_STATUSES];
        const [stats, categories, callList] = await Promise.all([
          callRpcOne<TicketStatsRow>(RPC.CUSTOMER_VIP_TICKET_STATS, {
            ...args,
            p_closed_statuses: closed,
            p_unhappy_from: UNHAPPY_FROM,
          }),
          callRpc<{ category: string | null; tickets: number | string }>(
            RPC.CUSTOMER_VIP_TICKET_CATEGORIES,
            args
          ),
          callRpc<TicketFactRow>(RPC.CUSTOMER_VIP_CALL_LIST, {
            ...args,
            p_closed_statuses: closed,
            p_min_level: CALL_LIST_MIN_LEVEL,
          }),
        ]);
        return { stats, categories, callList };
      })()
    : Promise.resolve(null);

  const [segmentRows, summary, tickets] = await Promise.all([
    segmentsPromise,
    summariseVipRule(supabase, shopId, rule),
    ticketReads,
  ]);

  const segments = segmentRows.map(mapSegment);
  const base = segments.length
    ? {
        customers: sumBy(segments, (s) => s.customers),
        buyers: sumBy(segments, (s) => s.buyers),
        repeatBuyers: sumBy(segments, (s) => s.repeatBuyers),
        marketingOptedIn: sumBy(segments, (s) => s.marketingOptedIn),
      }
    : null;

  const atRisk = (tickets?.callList ?? []).map(mapAtRisk);

  // The call list names customers; everything else on the panel is a count.
  if (atRisk.length) {
    await logDashboardAccess({
      shopId,
      action: "view",
      resourceType: "customers",
      purpose: "insights_vip_call_list",
      metadata: { panel: "customers", customers: atRisk.length },
    });
  }

  return {
    segments,
    base,
    vipRule: rule ? { ...rule, description: describeVipRule(rule) } : null,
    vip: rule && summary && tickets ? buildVip(summary, tickets.stats) : null,
    vipByCategory: tallyCategories(tickets?.categories ?? []),
    atRisk,
    spendExposed: count(tickets?.stats?.spend_exposed),
  };
}

// --- segments --------------------------------------------------------------

function mapSegment(row: Record<string, unknown>): SegmentTotal {
  const rfmGroup = (row.rfm_group as string | null) ?? null;
  return {
    rfmGroup,
    // Labelled from the shared rule so an RFM group Shopify adds tomorrow renders
    // as title-cased text rather than as a blank cell in the segment table.
    label: formatRfmGroup(rfmGroup),
    customers: count(row.customers),
    buyers: count(row.buyers),
    repeatBuyers: count(row.repeat_buyers),
    marketingOptedIn: count(row.marketing_opted_in),
    // `sum()` over an empty group is null in Postgres, and a segment with no
    // spend genuinely has spent zero — a count coercion is right here.
    totalSpent: count(row.total_spent),
  };
}

// --- VIP concentration -----------------------------------------------------

/**
 * The over-representation figures, and the one rate that can honestly be
 * computed beside them.
 *
 * `contactRate` is DISTINCT VIP CUSTOMERS who have a linked ticket over all VIP
 * customers — not tickets over customers. A VIP who wrote in four times about
 * one late parcel is one person who needed help, and dividing tickets by
 * headcount would report a "contact rate" above 100% the moment a single
 * customer opened enough threads.
 */
function buildVip(
  summary: { vipCustomers: number; buyersInWindow: number },
  stats: TicketStatsRow | null
): NonNullable<CustomerPanel["vip"]> {
  const vipCustomers = summary.vipCustomers;
  const contacted = count(stats?.vip_contacted);

  return {
    customers: vipCustomers,
    buyersInWindow: summary.buyersInWindow,
    ticketsLinked: count(stats?.tickets_linked),
    vipTickets: count(stats?.vip_tickets),
    // Null rather than 0 when there are no VIPs at all: "no VIP has contacted
    // support" and "there are no VIPs" are different facts, and only the first
    // is a rate.
    contactRate: vipCustomers > 0 ? contacted / vipCustomers : null,
  };
}

/**
 * VIP tickets by subject, biggest first. The counts come from SQL; this only
 * orders them.
 */
function tallyCategories(
  rows: { category: string | null; tickets: number | string }[]
): CustomerPanel["vipByCategory"] {
  return rows
    .map((row) => ({
      category: (row.category || null) as KnowledgeCategory | null,
      tickets: count(row.tickets),
    }))
    // Ties break on the category name so the bar order does not shuffle between
    // renders when two subjects sit on the same count.
    .sort((a, b) => b.tickets - a.tickets || (a.category ?? "").localeCompare(b.category ?? ""));
}

// --- the call list ---------------------------------------------------------

/**
 * The call list: VIP customers with an open, level 3+ ticket, filtered and
 * ordered by lifetime spend in `customer_vip_call_list`.
 *
 * 3 AND ABOVE, not 3 exactly (see CALL_LIST_MIN_LEVEL). "Open" is the queue's
 * own `CLOSED_STATUSES`, passed to SQL rather than restated there.
 */
function mapAtRisk(row: TicketFactRow): CustomerAtRisk {
  return {
    ticketId: row.ticket_id,
    customerName: row.customer_display_name ?? null,
    rfmGroup: row.rfm_group ?? null,
    label: formatRfmGroup(row.rfm_group),
    category: (row.category as KnowledgeCategory | null) ?? null,
    level: toLevel(row.level),
    happiness: toHappiness(row.happiness),
    status: row.status as TicketStatus,
    amountSpent: count(row.amount_spent),
    numberOfOrders: count(row.number_of_orders),
    firstMessageAt: row.first_message_at ?? null,
  };
}

// --- coercion --------------------------------------------------------------

/**
 * Both scales are 1-4 integers constrained in `04_support.sql`, but both are
 * nullable — a ticket the categoriser has not reached carries neither. Null has
 * to survive: a level-less ticket is not a level 1, and treating it as one would
 * quietly keep it off the call list on the strength of a value nobody assigned.
 */
function toLevel(value: unknown): TicketLevel | null {
  const n = toScore(value);
  return n === null ? null : (n as TicketLevel);
}

function toHappiness(value: unknown): TicketHappiness | null {
  const n = toScore(value);
  return n === null ? null : (n as TicketHappiness);
}

function toScore(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 4 ? n : null;
}

function sumBy<T>(rows: T[], pick: (row: T) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0);
}

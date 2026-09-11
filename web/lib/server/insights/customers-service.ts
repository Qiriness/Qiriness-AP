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
 * WHY THIS SERVICE READS ROWS WHEN THE OTHERS DO NOT. `customer_ticket_facts` is
 * one row per ticket that resolved to a customer — 145 today, and bounded by the
 * ticket count rather than the customer count. That is the entire justification:
 * the sibling read, `customer_segment_totals`, aggregates 58,201 customers in SQL
 * because reading those to count them is the mistake `shared.ts` documents. A
 * table-sized relation paged through PostgREST returns overlapping slices and
 * silently wrong totals; a bounded one does not. The bound is enforced below
 * rather than assumed — see `TICKET_FACT_LIMIT`.
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
  loadVipCustomers,
  loadVipRule,
  summariseVipRule,
} from "../../../../scripts/lib/vip-rule.mjs";
import { V } from "../../../../scripts/lib/tables.mjs";
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
import { count, getSupabaseClient, readView } from "./shared";

/**
 * The hard cap on the one row-level read, and the point at which this panel
 * refuses to render rather than under-report.
 *
 * At 145 rows there is a 3.4x margin, but "bounded" is a property of today's
 * data and not of the view. If ticket volume ever reaches this, every figure on
 * the panel would quietly describe the first 500 tickets PostgREST happened to
 * return — a VIP share computed from a truncated set looks exactly like a
 * correct one. Throwing surfaces it as `PanelError`, and the fix is to move the
 * grouping below into `06_analytics.sql` as further aggregates.
 */
const TICKET_FACT_LIMIT = 500;

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

export async function getCustomersPanel(shopId: string): Promise<CustomerPanel> {
  const supabase = getSupabaseClient();
  const rule = await loadVipRule(supabase, shopId);
  const [segmentRows, factRows, summary] = await Promise.all([
    // Biggest segment first, which on this shop means the panel opens on
    // PROSPECTS at 53,942 — the denominator problem stated by the data itself.
    readView<Record<string, unknown>>(V.CUSTOMER_SEGMENT_TOTALS, shopId, {
      order: "customers.desc",
    }),
    // Ordered by primary key, not by date: this ordering is never displayed, it
    // exists so two renders read the same 145 rows. `first_message_at` is
    // nullable and would leave ties unresolved at the cap boundary.
    readView<TicketFactRow>(V.CUSTOMER_TICKET_FACTS, shopId, {
      order: "ticket_id.asc",
      limit: TICKET_FACT_LIMIT,
    }),
    summariseVipRule(supabase, shopId, rule),
  ]);

  if (factRows.length >= TICKET_FACT_LIMIT) {
    throw new Error(
      `customer_ticket_facts returned ${factRows.length} rows, at the ${TICKET_FACT_LIMIT}-row read cap. ` +
        "Every VIP figure on this panel would be computed from a truncated set. " +
        "Move the grouping into an aggregate view in supabase/migrations/06_analytics.sql."
    );
  }

  const segments = segmentRows.map(mapSegment);
  const base = segments.length
    ? {
        customers: sumBy(segments, (s) => s.customers),
        buyers: sumBy(segments, (s) => s.buyers),
        repeatBuyers: sumBy(segments, (s) => s.repeatBuyers),
        marketingOptedIn: sumBy(segments, (s) => s.marketingOptedIn),
      }
    : null;

  // THE SHOP'S RULE, asked once for every customer behind a ticket — bounded by
  // TICKET_FACT_LIMIT, so one RPC body. The rule itself is applied in SQL
  // (vip_customers); nothing here compares a number.
  const linkedIds = [...new Set(factRows.map((row) => row.customer_id))];
  const vipIds = await loadVipCustomers(supabase, shopId, rule, linkedIds);
  const vipFacts = factRows.filter((row) => vipIds.has(row.customer_id));

  return {
    segments,
    base,
    vipRule: rule ? { ...rule, description: describeVipRule(rule) } : null,
    vip: rule && summary ? buildVip(summary, factRows, vipFacts) : null,
    vipByCategory: groupByCategory(vipFacts),
    atRisk: buildCallList(vipFacts),
    spendExposed: spendExposedToComplaints(factRows),
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
  factRows: TicketFactRow[],
  vipFacts: TicketFactRow[]
): NonNullable<CustomerPanel["vip"]> {
  const vipCustomers = summary.vipCustomers;
  const contacted = new Set(vipFacts.map((row) => row.customer_id)).size;

  return {
    customers: vipCustomers,
    buyersInWindow: summary.buyersInWindow,
    ticketsLinked: factRows.length,
    vipTickets: vipFacts.length,
    // Null rather than 0 when there are no VIPs at all: "no VIP has contacted
    // support" and "there are no VIPs" are different facts, and only the first
    // is a rate.
    contactRate: vipCustomers > 0 ? contacted / vipCustomers : null,
  };
}

/**
 * VIP tickets by subject, biggest first.
 *
 * Grouped in TypeScript over the same bounded read rather than as a second view,
 * because a second view would be a second place the VIP rule is applied — and
 * the whole point of deriving it here is that it is applied once.
 */
function groupByCategory(vipFacts: TicketFactRow[]): CustomerPanel["vipByCategory"] {
  const tally = new Map<string, number>();
  for (const row of vipFacts) {
    const key = row.category ?? "";
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }

  return [...tally.entries()]
    .map(([key, tickets]) => ({
      category: (key || null) as KnowledgeCategory | null,
      tickets,
    }))
    // Ties break on the category name so the bar order does not shuffle between
    // renders when two subjects sit on the same count.
    .sort((a, b) => b.tickets - a.tickets || (a.category ?? "").localeCompare(b.category ?? ""));
}

// --- the call list ---------------------------------------------------------

/**
 * VIP customers with an open, level 3+ ticket — the panel's one list of people
 * rather than numbers.
 *
 * "Open" reuses `CLOSED_STATUSES` from `ticket-stats.ts` instead of restating
 * it: the queue already decided that `resolved` and `closed` are done and the
 * other four (`open`, `awaiting_customer`, `awaiting_human`, `forwarded`) are
 * live. A second list here would drift the first time a status was added, and
 * this panel would keep offering the operator tickets the queue considers shut.
 *
 * Sorted by lifetime spend so the server's order is already the useful one; the
 * view re-sorts on the client when the operator asks for longest-waiting.
 */
function buildCallList(vipFacts: TicketFactRow[]): CustomerAtRisk[] {
  return vipFacts
    .filter((row) => isOpen(row.status) && (toLevel(row.level) ?? 0) >= CALL_LIST_MIN_LEVEL)
    .map(mapAtRisk)
    .sort((a, b) => b.amountSpent - a.amountSpent || a.ticketId.localeCompare(b.ticketId));
}

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

// --- exposure --------------------------------------------------------------

/**
 * Lifetime spend sitting behind an open complaint.
 *
 * DEDUPLICATED BY CUSTOMER. `customer_ticket_facts` is one row per ticket, so a
 * customer with three open unhappy threads carries their whole lifetime spend
 * three times — the naive sum is a multiple of the real exposure and gets larger
 * the angrier someone is, which is the opposite of a useful signal. The set of
 * customer ids is the fix, and `amount_spent` is a customer column so any of
 * their rows carries the same value.
 *
 * This is a spend-at-risk figure, not a forecast of lost revenue: it says how
 * much past custom is attached to people currently unhappy, which is the form a
 * support backlog has to take before a board can read it.
 */
function spendExposedToComplaints(factRows: TicketFactRow[]): number {
  const seen = new Map<string, number>();
  for (const row of factRows) {
    if (!isOpen(row.status)) continue;
    if ((toHappiness(row.happiness) ?? 0) < UNHAPPY_FROM) continue;
    seen.set(row.customer_id, count(row.amount_spent));
  }
  return [...seen.values()].reduce((total, spend) => total + spend, 0);
}

// --- coercion --------------------------------------------------------------

function isOpen(status: string): boolean {
  return !(CLOSED_STATUSES as readonly string[]).includes(status);
}

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

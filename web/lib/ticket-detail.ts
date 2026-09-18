/**
 * Case file -> the three blocks the expanded ticket row shows.
 *
 * Pure, like `ticket-stats.ts`: a stored `ticket_investigations` row goes in, a
 * `TicketResults` comes out. No I/O, no clock.
 *
 * WHY THE SUMMARY IS DERIVED RATHER THAN STORED. There is no summary column and
 * there deliberately is not one: a model asked for a prose summary *beside* the
 * evidence lists writes a fourth account of the ticket that can disagree with
 * all three — exactly the failure `do_not_claim` and the derived `replyIntent`
 * exist to prevent. What the agent established IS the result, so the summary is
 * the verified `established` claims and a headline read off the verdict.
 *
 * THE ACTION SENTENCE IS LOOKED UP, NOT COMPOSED, for the same reason
 * `MISSING_FIELDS` owns the question put to a customer. Only one branch shows
 * model prose — `handoff.action`, which is the model's whole job on a
 * `needs_human` verdict and is internal by construction.
 *
 * `summariseOrderContext` is the second projection here, over
 * `tickets.resolved_context` rather than the case file. Two sources, two
 * functions, one panel: the order facts come from Shopify via the resolution
 * pass and exist for tickets the agent never investigated.
 */

import type {
  TicketFact,
  DeliveryState,
  InvestigationVerdict,
  MissingField,
  OrderStatus,
  TicketOrderFacts,
  TicketReactionReport,
  TicketResults,
  TicketTracking,
} from "./types";
import {
  DELIVERY_STATE_LABELS,
  MISSING_FIELD_LABELS,
  ORDER_STATUS_LABELS,
} from "./types";

/** The slice of a `ticket_investigations` row this projection needs. */
export interface InvestigationRecord {
  verdict: InvestigationVerdict;
  established: { claim?: string | null }[];
  /** What no tool could settle, each with the reason it could not. */
  unverified: { claim?: string | null; why?: string | null }[];
  missing: { field?: string | null }[];
  handoff: { action?: string | null; why?: string | null } | null;
  /** Internal candidate order: a full bundle, same shape as resolved_context. */
  candidateOrder?: unknown;
  /** The reported reaction, on a cosmetovigilance ticket. Null everywhere else. */
  reactionReport?: unknown;
  investigatedAt: string | null;
}

/** Where the investigation got to, in one line. */
const HEADLINES: Record<InvestigationVerdict, string> = {
  answerable: "The agent found enough to answer this.",
  needs_customer_input: "The agent needs something from the customer first.",
  needs_human: "The agent could not settle this on its own.",
};

/** The fallback action per verdict, used when nothing more specific applies. */
const DEFAULT_ACTIONS: Record<InvestigationVerdict, string> = {
  answerable: "Reply to the customer using the results above.",
  // buildCaseFile downgrades a needs_customer_input verdict that names nothing
  // to ask for, so this line should be unreachable — it is here so a case file
  // written by an older pass still renders an action rather than an empty block.
  needs_customer_input: "Ask the customer for the missing details.",
  needs_human: "Read the thread and handle it by hand.",
};

export function summariseInvestigation(record: InvestigationRecord): TicketResults {
  const verdict = record.verdict;
  const findings = (record.established ?? [])
    .map((entry) => String(entry?.claim ?? "").trim())
    .filter(Boolean);

  return {
    verdict,
    headline: HEADLINES[verdict] ?? HEADLINES.needs_human,
    findings,
    // What could NOT be settled. A recurring entry here is usually a missing
    // knowledge article rather than a missing tool, which is only actionable if
    // somebody sees it — it was stored and rendered nowhere.
    unresolved: (record.unverified ?? [])
      .map((entry) => ({
        claim: String(entry?.claim ?? "").trim(),
        why: String(entry?.why ?? "").trim(),
      }))
      .filter((entry) => entry.claim.length > 0),
    action: deriveAction(verdict, record),
    // The reason belongs to the handoff, so it is shown only where the handoff
    // is: pairing it with "reply to the customer" would read as an instruction.
    actionReason:
      verdict === "needs_human" ? nonEmpty(record.handoff?.why) : null,
    // THE SAME PROJECTION AS A CONFIRMED ORDER, deliberately: the bundle is
    // built by the same builder, so rendering it needs no second set of
    // decisions about what a reader is shown. Only the headings differ.
    candidateOrder: hasOrder(record.candidateOrder)
      ? summariseOrderContext(record.candidateOrder)
      : null,
    reactionReport: toReactionReport(record.reactionReport),
    investigatedAt: record.investigatedAt,
  };
}

/** The outcomes the agent writes. Anything else is a row from a newer pass. */
const REACTION_OUTCOMES = [
  "identified",
  "ambiguous",
  "not_in_catalogue",
  "not_attributed",
] as const;

/**
 * The stored reaction record, narrowed for rendering.
 *
 * AN UNRECOGNISED OUTCOME BECOMES `unknown` RATHER THAN NULL. Dropping the whole
 * record would hide the customer's own words along with the outcome this
 * dashboard could not name — and those words are the half of the record that
 * never goes stale. A newer agent writing a fifth outcome should degrade to
 * "we could not place this", not to an empty panel.
 */
function toReactionReport(value: unknown): TicketReactionReport | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const outcome = String(record.outcome ?? "");
  return {
    outcome: (REACTION_OUTCOMES as readonly string[]).includes(outcome)
      ? (outcome as TicketReactionReport["outcome"])
      : "unknown",
    product: nonEmpty(record.product),
    claimed: nonEmpty(record.claimed),
    reaction: nonEmpty(record.reaction),
    alternatives: Array.isArray(record.alternatives)
      ? record.alternatives.map((entry) => String(entry ?? "").trim()).filter(Boolean)
      : [],
  };
}

/** A bundle with an order in it, as opposed to the `{}` the column defaults to. */
function hasOrder(bundle: unknown): boolean {
  return Boolean((bundle as { order?: unknown } | null)?.order);
}

function deriveAction(verdict: InvestigationVerdict, record: InvestigationRecord): string {
  if (verdict === "needs_customer_input") {
    const wanted = (record.missing ?? [])
      .map((entry) => entry?.field)
      .filter((field): field is MissingField => Boolean(field && field in MISSING_FIELD_LABELS))
      .map((field) => MISSING_FIELD_LABELS[field]);

    if (wanted.length > 0) {
      return `Ask the customer for ${joinList(wanted)}.`;
    }
  }

  if (verdict === "needs_human") {
    // The one place model prose reaches this panel. It is internal by
    // construction — `toDraftingPrompt` omits the handoff entirely.
    const action = nonEmpty(record.handoff?.action);
    if (action) {
      return action;
    }
  }

  return DEFAULT_ACTIONS[verdict] ?? DEFAULT_ACTIONS.needs_human;
}

/**
 * `tickets.resolved_context` -> the order lines the panel shows.
 *
 * READS THE BUNDLE, DERIVES NOTHING. `buildOrderContext` already turned four
 * Shopify status columns and a fulfillments array into one status and one
 * delivery state; re-deriving either here would give the dashboard a second
 * opinion about the same order, and the two would disagree the first time one
 * of them changed. This function labels what is stored and stops.
 *
 * Returns null when the bundle is empty — `resolved_context` defaults to `{}`
 * and stays that way until an order number is confirmed and the context pass
 * runs, so "no order facts" is the normal state for most tickets.
 */
export function summariseOrderContext(context: unknown): TicketOrderFacts | null {
  const order = (context as any)?.order;
  if (!order || typeof order !== "object") {
    return null;
  }

  const delivery = order.delivery ?? {};
  const facts: TicketOrderFacts = {
    orderName: nonEmpty(order.name),
    // WHO THE ORDER BELONGS TO, read off the bundle's customer block rather than
    // its order block: `orders` stores no name at all, only a hash and a masked
    // address, so the account the order points at is the only name there is.
    customerName: nonEmpty((context as any)?.customer?.name),
    contactEmail: nonEmpty(order.contactEmailMasked),
    // WEB IS THE ABSENCE OF A MARK, not a label saying "Online Store". A fact
    // restated on 1,500 of 2,006 orders stops being read, and the whole value
    // here is that an unusual channel catches the eye.
    channel: marketplaceChannel(order.channel),
    orderStatus: labelOrderStatus(order.status?.overall),
    trackingStatus: labelDeliveryState(delivery.state),
    tracking: readTracking(delivery.tracking),
    items: readItems(order.items),
    resolvedAt: nonEmpty((context as any)?.resolvedAt),
    // Not in the bundle: how the number was confirmed is the ticket's, and the
    // service sets it from `metadata.order_resolution`.
    buyerUnverified: false,
    linkedByPerson: false,
  };

  // A bundle that carries none of these lines is the same as no bundle: the
  // panel would render an empty block with a heading over it.
  if (
    !facts.orderName &&
    !facts.customerName &&
    !facts.contactEmail &&
    !facts.orderStatus &&
    !facts.trackingStatus &&
    !facts.channel &&
    facts.tracking.length === 0 &&
    facts.items.length === 0
  ) {
    return null;
  }
  return facts;
}

/**
 * The channel, when it is worth naming.
 *
 * `buildOrderContext` stores `sales_channel || source_name`, which is "Online
 * Store" for 1,500 of 2,006 orders and one of `Amazon` (467), `Mirakl Connect`
 * (36) or `Shop` (3) for the rest. Only the rest are returned: the mark exists
 * to say "this order does not behave like the others", and one that appeared on
 * three quarters of orders would say nothing.
 *
 * NOT AN ALLOW-LIST OF MARKETPLACES. A new channel added in Shopify tomorrow
 * should show up on the day it produces its first support ticket, not once
 * somebody remembers to add it here — so anything that is not the online store
 * is named, whatever it is called.
 */
function marketplaceChannel(channel: unknown): string | null {
  const name = nonEmpty(channel);
  if (!name) return null;
  const normalised = name.trim().toLowerCase();
  return normalised === "online store" || normalised === "web" ? null : name;
}

/** Line-item titles, deduplicated — a bundle repeats a title per unit. */
function readItems(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  return [
    ...new Set(
      items
        .map((item) => nonEmpty((item as { title?: string })?.title))
        .filter((title): title is string => Boolean(title))
    ),
  ];
}

function labelOrderStatus(value: unknown): string | null {
  const key = nonEmpty(value as string);
  if (!key) return null;
  // An unrecognised status is shown raw rather than dropped: the mapper can grow
  // a value before this table does, and hiding it would look like "no status".
  return ORDER_STATUS_LABELS[key as OrderStatus] ?? key;
}

function labelDeliveryState(value: unknown): string | null {
  const key = nonEmpty(value as string);
  if (!key) return null;
  return DELIVERY_STATE_LABELS[key as DeliveryState] ?? key;
}

/** One entry per parcel that actually has a number — the rest carry nothing. */
function readTracking(tracking: unknown): TicketTracking[] {
  if (!Array.isArray(tracking)) {
    return [];
  }
  return tracking
    .map((entry) => ({
      number: nonEmpty(entry?.number) ?? "",
      carrier: nonEmpty(entry?.carrier),
      url: nonEmpty(entry?.url),
    }))
    .filter((entry) => entry.number.length > 0);
}

/** "a", "a and b", "a, b and c" — no Oxford comma; the dashboard is British. */
function joinList(items: string[]): string {
  if (items.length <= 1) {
    return items[0] ?? "";
  }
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// `unknown` rather than `string | null | undefined`: it is also the narrowing
// step for jsonb fields read straight off a row, where the type is a promise
// nobody checked. The body already coerces, so widening the signature costs
// nothing and removes the cast every such caller would otherwise write.
function nonEmpty(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * `ticket_investigations.evidence_gaps` -> the facts the panel lists.
 *
 * THE THIRD PROJECTION IN THIS FILE, and the reason it exists is the goal the
 * other two only half meet: a person should not have to open Shopify. They
 * already do not for orders, because `summariseOrderContext` reads a bundle the
 * resolution pass persists. For every other family the specifics were derived
 * during the investigation, read once to settle a finding, and discarded — so a
 * promotions ticket showed the model's prose and nothing underneath it.
 *
 * LABELS, DERIVES NOTHING, exactly like `summariseOrderContext`. The agent
 * already decided which product matched and why a code was refused; deciding it
 * again here would give the dashboard a second opinion, and the two would
 * disagree the first time either changed.
 *
 * A GAP WITH NO `details` IS NOT A FACT. Most needs carry none — the tool came
 * back empty-handed, or nothing branches on the value — and a heading over an
 * empty list is worse than an absent row.
 */
export function summariseFacts(gaps: unknown): TicketFact[] {
  if (!Array.isArray(gaps)) {
    return [];
  }

  return gaps
    .map((gap) => {
      const details = (gap as any)?.details;
      if (!details || typeof details !== "object") {
        return null;
      }
      const lines = describeDetails((gap as any)?.need, details);
      if (lines.length === 0) {
        return null;
      }
      return {
        need: String((gap as any).need ?? ""),
        label: nonEmpty((gap as any).label) ?? String((gap as any).need ?? ""),
        outcome: labelFinding((gap as any).finding),
        lines,
      } satisfies TicketFact;
    })
    .filter((fact): fact is TicketFact => fact !== null);
}

/**
 * One need's details as display lines.
 *
 * Per-need rather than a generic object walker: the agent named these fields
 * deliberately, and a walker would render whichever ones happened to be there —
 * the same mistake `JSON.stringify` made on the order bundle.
 */
function describeDetails(need: unknown, details: any): string[] {
  const lines: string[] = [];

  switch (need) {
    case "product_identity": {
      const products: string[] = Array.isArray(details.products) ? details.products : [];
      if (products.length === 0) break;
      // "Could be one of these" is the whole content of an ambiguous match, so
      // the wording has to say which it is.
      lines.push(
        details.matched === false
          ? `Closest in the catalogue: ${products.join(", ")}`
          : products.length > 1
            ? `Could be: ${products.join(", ")}`
            : products[0]
      );
      break;
    }

    case "product_availability": {
      const products: any[] = Array.isArray(details.products) ? details.products : [];
      for (const product of products) {
        const title = nonEmpty(product?.title);
        if (!title) continue;
        lines.push(`${title} — ${product?.inStock ? "in stock" : "out of stock"}`);
      }
      break;
    }

    case "product_property":
    case "policy_answer":
    case "brand_answer": {
      // THE ONE LINE HERE THAT IS A TO-DO. The library could not answer this, so
      // the agent will keep failing the same question until an article covers
      // it — which only happens if somebody is told.
      if (details.libraryAnswered !== false) break;
      lines.push(
        typeof details.closest === "number"
          ? `No approved article answered this — closest match ${details.closest}`
          : "No approved article covers this"
      );
      break;
    }

    case "promotion_identity": {
      const codes: string[] = Array.isArray(details.codes) ? details.codes : [];
      if (codes.length > 0) lines.push(codes.join(", "));
      break;
    }

    case "promotion_validity":
    case "promotion_eligibility": {
      const code = nonEmpty(details.code);
      if (code) {
        lines.push(details.found === false ? `${code} — no such code` : code);
      }
      for (const failed of Array.isArray(details.failedChecks) ? details.failedChecks : []) {
        const label = PROMOTION_CHECK_LABELS[String(failed?.check)] ?? nonEmpty(failed?.check);
        if (label) lines.push(`Blocked: ${label}`);
      }
      break;
    }

    case "customer_identity":
    case "customer_account_state": {
      const name = nonEmpty(details.name);
      if (name) lines.push(details.isVip ? `${name} (VIP)` : name);
      if (typeof details.ordersCount === "number") {
        lines.push(`${details.ordersCount} order${details.ordersCount === 1 ? "" : "s"}`);
      }
      break;
    }

    default:
      break;
  }

  return lines;
}

/** Why a code was refused, in the panel's words rather than the agent's key. */
const PROMOTION_CHECK_LABELS: Record<string, string> = {
  minimum: "basket below the minimum",
  window: "outside the offer dates",
  status: "the offer is not active",
  usage_limit: "usage limit reached",
  once_per_customer: "already used by this customer",
  items: "does not apply to these items",
};

/**
 * A finding is a machine value (`expired`, `out_of_stock`). Unrecognised ones
 * are shown raw rather than dropped, for the reason `labelOrderStatus` gives:
 * the agent's vocabulary can grow before this table does, and hiding a value
 * would read as "nothing was established".
 */
const FINDING_LABELS: Record<string, string> = {
  active: "active",
  expired: "expired",
  not_yet_started: "not started yet",
  inactive: "inactive",
  not_found: "not found",
  eligible: "eligible",
  blocked: "blocked",
  undetermined: "undetermined",
  in_stock: "in stock",
  out_of_stock: "out of stock",
  resolved: "resolved",
  ambiguous: "ambiguous",
  none: "none",
  unknown: "unknown",
};

function labelFinding(value: unknown): string | null {
  const key = nonEmpty(value as string);
  if (!key) return null;
  return FINDING_LABELS[key] ?? key;
}

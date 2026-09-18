// What linking an order to a ticket does to the ticket, whoever links it.
//
// Pure: a ticket row and an order in, columns out. Two writers use it — the
// worker's order resolution, when a late confirmation makes a case file stale,
// and the dashboard, when a person adds, changes or confirms a ticket's order —
// so the rule for "the investigation must run again" exists once.
//
// It lives in `scripts/lib` because `web/` and `agent/` both read it, and it has
// node tests here because `web/` has no test runner.

/**
 * The statuses only the agent sets (`TICKET_STATUS_BY_VERDICT`). The dashboard
 * writes `open`, `resolved` and `closed`, so reopening from these two can never
 * overrule a person.
 */
export const AGENT_SET_STATUSES = Object.freeze(['awaiting_customer', 'awaiting_human']);

/** Which dashboard control linked the order. Recorded, never branched on. */
export const ORDER_LINK_SOURCES = Object.freeze(['add', 'edit', 'candidate']);

/** `verified_by` for an order a person linked: they are the proof. */
export const BY_PERSON = 'manual';

/**
 * Queue the investigation again, and reopen a status the agent parked.
 *
 * The investigation claims open tickets only and re-sets the status from its new
 * verdict. A person's `resolved` or `closed`, a `forwarded` thread and `spam` are
 * left exactly as they are, and get no investigation.
 *
 * `evenIfNeverInvestigated`: the worker's late confirmation only matters to a
 * ticket that already has a case file — a first investigation reads the order
 * anyway. A person changing the order means it on any open ticket.
 */
export function reinvestigationColumns(ticket = {}, { evenIfNeverInvestigated = false } = {}) {
  if (!ticket.investigated_at && !evenIfNeverInvestigated) {
    return {};
  }
  if (ticket.status === 'open') {
    return { needs_investigation: true };
  }
  if (AGENT_SET_STATUSES.includes(ticket.status)) {
    return { needs_investigation: true, status: 'open' };
  }
  return {};
}

/**
 * The number a person typed, or null. `6669`, `#6669` and ` # 6669 ` are the
 * same order; anything carrying other text is refused rather than guessed at,
 * because a `Q00…` reference or a tracking number is not an order number.
 */
export function parseOrderNumber(raw) {
  const match = /^\s*#?\s*(\d{1,9})\s*$/.exec(String(raw ?? ''));
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** `#6669` and `6669` compare equal; null only equals null. */
export function sameOrder(a, b) {
  const left = parseOrderNumber(a);
  const right = parseOrderNumber(b);
  return left === null || right === null ? a == null && b == null : left === right;
}

/**
 * How the order relates to whoever wrote in — shown, never enforced. A person
 * may know it is a gift or a second mailbox; the line is there so they decide
 * with it in view.
 */
export function describeOrderMatch({ orderEmailHash = null, ticketEmailHash = null, anonymous = false } = {}) {
  if (anonymous) return 'anonymous_marketplace';
  if (!orderEmailHash || !ticketEmailHash) return 'unknown';
  return orderEmailHash === ticketEmailHash ? 'sender_email' : 'different_email';
}

/**
 * Every column a person linking an order writes.
 *
 * The number, the rebuilt order bundle, the trail of who and what it replaced,
 * and the re-investigation. `metadata` is merged, not replaced: the
 * categorisation and investigation trails live beside `order_resolution`.
 *
 * Typed for `web/`, which reads this through `allowJs` and would otherwise infer
 * `actorId` as `null` from its default.
 * @param {{ ticket?: any, order: any, context?: any, source: string,
 *   actorId?: string | null, anonymous?: boolean, now?: Date }} args
 */
export function manualOrderColumns({
  ticket = {},
  order,
  context,
  source,
  actorId = null,
  anonymous = false,
  now = new Date()
} = {}) {
  if (!order?.name) throw new Error('manualOrderColumns requires the order row.');
  if (!ORDER_LINK_SOURCES.includes(source)) throw new Error(`Unknown order link source: ${source}`);
  const at = now.toISOString();

  return {
    shopify_order_number: order.name,
    resolved_context: context ?? {},
    context_resolved_at: at,
    // Same rule as the context pass: the ticket's customer is who wrote in, so
    // it is only filled where none was known.
    ...(order.customer_id && !ticket.customer_id ? { customer_id: order.customer_id } : {}),
    metadata: {
      ...(ticket.metadata || {}),
      order_resolution: {
        status: 'confirmed',
        verified_by: BY_PERSON,
        matched_by: source,
        buyer_anonymous: Boolean(anonymous),
        previous_order: ticket.shopify_order_number ?? null,
        set_by: actorId,
        detail:
          ticket.shopify_order_number
            ? `Changed by a person from ${ticket.shopify_order_number} to ${order.name}.`
            : `Linked by a person to ${order.name}.`,
        candidates: [],
        resolved_at: at
      }
    },
    ...reinvestigationColumns(ticket, { evenIfNeverInvestigated: true })
  };
}

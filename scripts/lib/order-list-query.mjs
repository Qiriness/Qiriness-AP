/**
 * The Orders page's query string, and the one judgement that page adds to the
 * data: which colour an order's destination is ringed in.
 *
 * Pure and isomorphic, like insights-range.mjs, so what the server trusts from
 * the URL and what the tests exercise are the same function.
 */

export const ORDER_PAGE_SIZE = 50;

/** A page number past this is a typo, not a request. */
const MAX_PAGE = 10_000;

/** Longer than any order name, email or tracking number anyone would paste. */
export const SEARCH_MAX_LENGTH = 80;

const first = (value) => (Array.isArray(value) ? value[0] : value);

/**
 * What someone typed -> the text `orders_list()` searches, or null for none.
 *
 * LIKE WILDCARDS ARE REMOVED HERE, not escaped in SQL: `%` and `_` typed into a
 * box would otherwise match everything, and a backslash would change what the
 * pattern means. No order name, name, email or tracking number needs them.
 * The search box submits through this too, so what it sends and what the URL
 * reads back are the same string.
 */
export function normaliseSearch(value) {
  const text = String(first(value) ?? '')
    .replace(/[%_\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SEARCH_MAX_LENGTH)
    .trim();
  return text || null;
}

/**
 * `?status=UNFULFILLED&country=BE&vip=true&page=3` -> the filters.
 *
 * Anything malformed is dropped rather than rejected: a bad link opens the
 * unfiltered list, which is what someone following it can recover from.
 * `??` is the country of an order with no destination, as the facets report it.
 */
export function parseOrderListQuery(params = {}) {
  const status = String(first(params.status) ?? '').trim().toUpperCase();
  const country = String(first(params.country) ?? '').trim().toUpperCase();
  const vip = String(first(params.vip) ?? '').trim().toLowerCase();
  const page = Number(String(first(params.page) ?? '').trim());

  return {
    status: /^[A-Z_]{1,40}$/.test(status) ? status : null,
    country: /^([A-Z]{2}|\?\?)$/.test(country) ? country : null,
    vip: vip === 'true' || vip === '1',
    search: normaliseSearch(params.q),
    page: Number.isInteger(page) && page >= 1 ? Math.min(page, MAX_PAGE) : 1
  };
}

/**
 * Whole days an order has waited to ship, or null when it is not waiting.
 *
 * WHETHER it waits is decided in SQL (`orders_list().awaiting_fulfilment`,
 * open_orders()'s rule); this only counts. Floored, so an order placed this
 * morning reads 0 days rather than rounding up to a day it has not yet waited.
 */
export function delayDays(processedAt, awaiting, now = new Date()) {
  if (!awaiting || !processedAt) return null;
  const placed = Date.parse(processedAt);
  if (!Number.isFinite(placed)) return null;
  return Math.max(0, Math.floor((now.getTime() - placed) / 86_400_000));
}

/** The filter and page arguments `orders_list()` takes. */
export function orderListArgs(query, pageSize = ORDER_PAGE_SIZE) {
  return {
    p_fulfillment_status: query.status,
    p_country: query.country,
    p_vip_only: query.vip,
    p_search: query.search ?? null,
    p_limit: pageSize,
    p_offset: (query.page - 1) * pageSize
  };
}

/**
 * `#7008`, `7008` and the integer 7008 -> `"7008"`; anything else -> null.
 *
 * A ticket stores the order NAME the resolver confirmed (`#7008`); an order row
 * carries both the name and the integer. Comparing on this key means the two
 * cannot miss each other over a hash sign. A reference that is not a plain
 * Shopify number (`Q00 26200111`, a marketplace id) matches nothing rather than
 * matching its digits.
 */
export function orderNumberKey(value) {
  if (value === null || value === undefined) return null;
  const match = /^#?\s*(\d+)$/.exec(String(value).trim());
  return match ? String(Number(match[1])) : null;
}

const BAND_RANK = { high: 3, medium: 2, low: 1 };

/**
 * Open tickets per order -> `{ band, openTickets }`, keyed by `orderNumberKey`.
 *
 * THE BAND IS THE QUEUE'S, never re-scored here: each ticket arrives carrying
 * the `priorityBand` ticket-priority.mjs gave it on /tickets, so a red ring on
 * an order is the same red as the ticket's bar in the queue. Where several open
 * tickets name one order, the most urgent sets the colour — the ring answers
 * "is somebody waiting on this order, and how badly".
 *
 * Closed tickets leave no mark: a ring for a conversation that is over would
 * say somebody is waiting when nobody is.
 */
export function ticketMarksByOrder(tickets) {
  const marks = new Map();
  for (const ticket of tickets ?? []) {
    if (!ticket?.open) continue;
    const key = orderNumberKey(ticket.orderNumber);
    const rank = BAND_RANK[ticket.band];
    if (!key || !rank) continue;

    const mark = marks.get(key);
    if (!mark) {
      marks.set(key, { band: ticket.band, openTickets: 1 });
      continue;
    }
    mark.openTickets += 1;
    if (rank > BAND_RANK[mark.band]) mark.band = ticket.band;
  }
  return marks;
}

/** A Shopify enum as words: `PARTIALLY_REFUNDED` -> `Partially refunded`. */
export function enumLabel(value) {
  if (!value) return '';
  const words = String(value).toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `UNKNOWN` is the facets' name for an order Shopify gave no status. */
export function fulfillmentStatusLabel(status) {
  if (!status || status === 'UNKNOWN') return 'No status';
  return enumLabel(status);
}

/**
 * The fulfilment pill: Shopify's status, unless the order has nothing left to ship.
 *
 * AN ORDER EMPTIED BEFORE IT SHIPPED STAYS `UNFULFILLED` FOR EVER. Cancelling
 * or refunding every line takes each `current_quantity` to 0 but leaves the
 * fulfilment status where it was. Measured 2026-09-18: all 14 `UNFULFILLED`
 * orders in the shop have 0 items left, 7 of them cancelled and 7 refunded
 * without a cancel, so the pill was calling finished orders "Unfulfilled".
 *
 * ZERO ITEMS IS THE GATE, not the refund alone: a partly refunded order that
 * still has something to ship is still waiting. Cancelled wins over refunded
 * because a cancel is the fuller answer (it is usually refunded too). An empty
 * order that is neither keeps Shopify's word, since there is nothing to say
 * instead.
 *
 * `status` is the key the pill is styled on; `CANCELLED` and `REFUNDED` are ours,
 * never Shopify fulfilment values. The filter still selects on Shopify's status.
 */
export function fulfillmentDisplay({ status, units, cancelled, financialStatus }) {
  const shipped = status === 'FULFILLED' || status === 'RESTOCKED';
  if (!shipped && Number(units) === 0) {
    if (cancelled) return { status: 'CANCELLED', label: 'Cancelled' };
    if (financialStatus === 'REFUNDED') return { status: 'REFUNDED', label: 'Refunded' };
  }
  return { status: status || 'UNKNOWN', label: fulfillmentStatusLabel(status) };
}

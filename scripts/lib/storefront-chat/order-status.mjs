/**
 * Where an order stands, from its dates and the shop's own timings
 * (docs/decisions/storefront-advisor.md § The storefront agent reads one
 * order's status by its number). Pure: the reader passes the row, the policy
 * parameters and today.
 *
 *   not shipped, within dispatch_days of the order        preparing
 *   not shipped, past it                                   dispatch_delayed
 *   shipped, within the delivery days (home or abroad)     on_the_way
 *   shipped, past them                                     delivery_late
 *   a delivery date                                        delivered
 *   cancelled                                              cancelled
 *   a timing the shop has not set                          timing_unknown (never guessed)
 *
 * Working days, Monday to Friday (bank holidays are not known here: a day
 * early at worst). Partly shipped orders are judged on what is still to ship.
 *
 * WHAT LEAVES: the order's name, the day it was placed, the day it shipped,
 * the status. Never the destination (it only picks the delivery time), never
 * tracking, never anything about the person.
 */

const DAY_MS = 24 * 3600 * 1000;
export const STATUSES = ['preparing', 'dispatch_delayed', 'on_the_way', 'delivery_late', 'delivered', 'cancelled', 'timing_unknown'];

/** Working days strictly after `from`, up to and including `to`. */
export function workingDaysBetween(from, to) {
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  let n = 0;
  for (let t = start + DAY_MS; t <= end; t += DAY_MS) {
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6) n += 1;
  }
  return n;
}

const day = (value) => {
  const t = Date.parse(value ?? '');
  return Number.isFinite(t) ? new Date(t) : null;
};
const iso = (d) => (d ? d.toISOString().slice(0, 10) : null);
// `null >= 0` is true in JavaScript: an unset timing must not read as « 0 days ».
const isDays = (n) => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/**
 * @param {{ name: string, processed_at: string, fulfillment_status?: string | null, cancelled_at?: string | null,
 *   delivered_at?: string | null, fulfillments?: { created_at?: string, status?: string }[], country?: string | null }} order
 * @param {{ dispatchDays: number | null, homeDeliveryDays: number | null, abroadDeliveryDays: number | null, homeCountry: string }} timings
 * @returns {{ order: string, ordered_on: string | null, status: string, shipped_on?: string, working_days_since?: number, usual_working_days?: number }}
 */
export function orderStatus(order, timings, now = new Date()) {
  const ordered = day(order.processed_at);
  const base = { order: order.name, ordered_on: iso(ordered) };
  if (order.cancelled_at) return { ...base, status: 'cancelled' };
  const delivered = day(order.delivered_at);
  if (delivered) return { ...base, status: 'delivered', delivered_on: iso(delivered) };

  const shipped = (order.fulfillments ?? [])
    .filter((f) => f && String(f.status ?? 'SUCCESS').toUpperCase() !== 'CANCELLED')
    .map((f) => day(f.created_at))
    .filter(Boolean)
    .sort((a, b) => b - a)[0] ?? null;
  const status = String(order.fulfillment_status ?? '').toUpperCase();
  const fullyShipped = status === 'FULFILLED' && shipped;

  if (!fullyShipped) {
    if (!ordered || !isDays(timings.dispatchDays)) return { ...base, status: 'timing_unknown' };
    const since = workingDaysBetween(ordered, now);
    return { ...base, status: since <= timings.dispatchDays ? 'preparing' : 'dispatch_delayed', working_days_since: since, usual_working_days: timings.dispatchDays };
  }
  const home = !order.country || order.country === timings.homeCountry;
  const usual = home ? timings.homeDeliveryDays : timings.abroadDeliveryDays;
  if (!isDays(usual)) return { ...base, status: 'timing_unknown', shipped_on: iso(shipped) };
  const since = workingDaysBetween(shipped, now);
  return { ...base, status: since <= usual ? 'on_the_way' : 'delivery_late', shipped_on: iso(shipped), working_days_since: since, usual_working_days: usual };
}

/** « #1234 », « n°1234 », « 1234 » → 1234; anything else → null. */
export function parseOrderNumber(value) {
  const m = String(value ?? '').trim().match(/^(?:#|n[°o]\s*|no\.?\s*|commande\s*|order\s*)?\s*(\d{1,9})$/iu);
  return m ? Number(m[1]) : null;
}

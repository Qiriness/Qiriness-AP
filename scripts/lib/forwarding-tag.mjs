import { isActive } from './forwarding-destinations.mjs';
import { planRoute } from '../../agent/src/routing/destination-router.mjs';

// Whether a ticket is being handed to a colleague, for the tag on the queue.
//
// Read from what the forwarding pass leaves behind — its decision
// (`ticket_routing`) and its attempts (`ticket_forwards`) — so the tag says what
// the worker WILL do or DID, never a second guess at the route. Pure: the web
// reader supplies the rows. DECISIONS.md § Forwarding.

/** The states the tag can show, in the order a ticket passes through them. */
export const FORWARDING_TAG_STATES = ['after_first_reply', 'pending', 'failed', 'forwarded'];

/**
 * @param {object} input
 * @param {string | null} [input.ticketCategory] the ticket's category now
 * @param {any} [input.routing]       its `ticket_routing` row, or null
 * @param {any[]} [input.forwards]    its `ticket_forwards` rows
 * @param {any} [input.destination]   the `forwarding_destinations` row the decision names, or null
 * @param {boolean} [input.switchedOn] whether `forwarding_settings.forward_since` is set
 * @returns `{ destination, state, at }` or null when nothing is forwarded or due
 */
export function forwardingTag({ ticketCategory, routing = null, forwards = [], destination = null, switchedOn = false } = {}) {
  // WHAT LEFT STAYS SAID, whatever has changed since: a colleague has the mail,
  // and a person reading the queue needs to know that before answering it too.
  const sent = forwards.filter((f) => f?.status === 'sent');
  if (sent.length > 0) {
    const latest = sent.reduce((a, b) => (Date.parse(b.created_at) > Date.parse(a.created_at) ? b : a));
    return {
      destination: latest.destination_label ?? routing?.destination_label ?? null,
      state: 'forwarded',
      at: latest.created_at ?? null
    };
  }

  // Nothing sent yet: only a decision that the next pass would still act on.
  if (!switchedOn || routing?.outcome !== 'forward') return null;
  // A decision taken on another category is re-taken by the next pass, which
  // may keep the ticket; until then it promises nothing.
  if (routing.category !== ticketCategory) return null;
  if (!isActive(destination)) return null;

  const label = destination.label ?? routing.destination_label;
  if (forwards.some((f) => f?.status === 'failed')) {
    return { destination: label, state: 'failed', at: null };
  }
  return {
    destination: label,
    state: destination.timing === 'after_first_reply' ? 'after_first_reply' : 'pending',
    at: null
  };
}

/**
 * Where a situation's tickets go, for the tag on the Rules page.
 *
 * THE WORKER'S OWN PLAN (`planRoute`) on the situation's category and kind, so
 * the tag cannot disagree with the pass. Forwarding follows the ticket's
 * category, not its situation; a situation is tagged because the category it
 * belongs to is forwarded, and a ticket filed elsewhere is not.
 *
 * @param {object} input
 * @param {string | null} [input.category]    the situation's category
 * @param {string | null} [input.requestKind] the situation's request kind
 * @param {any[]} [input.destinations]        every `forwarding_destinations` row
 * @param {boolean} [input.switchedOn]        whether `forwarding_settings.forward_since` is set
 * @returns `{ route: 'fixed' | 'choose', destinations: [{ label, timing }] }` or null when it stays
 */
export function situationForwarding({ category = null, requestKind = null, destinations = [], switchedOn = false } = {}) {
  if (!switchedOn || !category) return null;
  const plan = planRoute({ ticket: { category, request_kind: requestKind }, destinations });
  if (plan.route === 'stays') return null;
  return {
    route: plan.route,
    destinations: plan.candidates.map((d) => ({ label: d.label, timing: d.timing }))
  };
}

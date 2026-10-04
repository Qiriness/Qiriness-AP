import { days } from '../../../scripts/lib/parameters.mjs';
import { orderStates } from '../resolution/order-context.mjs';
import { STALE_TRANSIT_DAYS } from './investigation-rules.mjs';

// The order states as the investigation reads them, from one place.
//
// TWO READERS, ONE DERIVATION. `getOrderContext` derives the states a case file
// is decided on; the change router (casework/change-router.mjs) derives them
// again to ask whether that decision still holds. Two copies of the parameter
// block would be free to disagree, and a router that read a threshold the
// investigation did not would see a change on every poll.
//
// FROM THE MERCHANT, NOT FROM CODE, except the stale-transit threshold. The
// returns window, the dispatch promise and the two delivery windows are the
// shop's numbers (`agent_parameters`): unset arrives as null and resolves
// `unknown`, never a default. The stale-transit threshold is a measurement this
// codebase made, so it lives in investigation-rules.mjs.
//
// THE CLOCK IS THE CALLER'S. The investigation passes when the customer wrote
// (DECISIONS § The clock is the customer's message); the router passes now, for
// live tickets only (DECISIONS § Change router).

/** The fixed order-state needs, in the evidence vocabulary's spelling. */
export const ORDER_STATE_KEYS = Object.freeze([
  'order_state',
  'delivery_state',
  'dispatch_state',
  'delivery_delay_state',
  'payment_state',
  'refund_state',
  'return_eligibility'
]);

/**
 * @param context    a `resolved_context` bundle
 * @param parameters the shop's parameters (`Map`), or null
 * @param now        the clock the time-based states are measured against
 */
export function orderStatesAt(context, parameters, now) {
  return orderStates(context, {
    staleTransitDays: STALE_TRANSIT_DAYS,
    returnsWindowDays: days(parameters, 'returns_window_days'),
    dispatchDays: days(parameters, 'dispatch_days'),
    // Picked on the shipping country by `deliveryDelayState`.
    franceDeliveryDays: days(parameters, 'france_delivery_days'),
    abroadDeliveryDays: days(parameters, 'abroad_delivery_days'),
    now
  });
}

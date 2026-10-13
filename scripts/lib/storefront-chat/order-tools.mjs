import { days } from '../parameters.mjs';
import { getPolicy } from './knowledge-tools.mjs';
import { orderStatus, parseOrderNumber } from './order-status.mjs';

/**
 * `get_order_status`: one order's status by its number, with the shop's
 * dispatch and delivery policy, so the reply says which of: being prepared,
 * sorry for the delay, on its way, late (owner, 2026-10-13). Every order
 * answer ends with the contact form (the reply's `contact`, set by the agent).
 */

export const ORDER_TOOL = 'get_order_status';
/** Lookups a conversation may make: enough for a customer's own orders, too few to walk the numbers. */
export const MAX_ORDER_LOOKUPS = 3;
/** The country the shop's « France » delivery time applies to (parameter `france_delivery_days`). */
const HOME_COUNTRY = 'FR';

export function orderToolDefinition() {
  return {
    type: 'function',
    function: {
      name: ORDER_TOOL,
      description:
        'The status of ONE order the customer names by its order number (« #1234 », « commande 1234 »): whether it is being prepared, delayed, on its way, late, delivered or cancelled, the day it was placed and shipped, and the shop\'s dispatch and delivery policy. Returns nothing about the person. Call it only with a number the customer gave; never ask for an email, a name or an address.',
      strict: true,
      parameters: {
        type: 'object',
        properties: { order_number: { type: 'string', description: 'The order number exactly as the customer gave it, e.g. #1234 or 1234.' } },
        required: ['order_number'],
        additionalProperties: false,
      },
    },
  };
}

/**
 * @param {{ order_number?: string }} args
 * @param {{ readOrder: Function | null, shopDomain: string | null, knowledge: object | null, lookupsSoFar: number, now?: Date }} ctx
 */
export async function runOrderTool(args, { readOrder, shopDomain, knowledge, lookupsSoFar, now = new Date() }) {
  const orderNumber = parseOrderNumber(args?.order_number);
  if (!orderNumber) return { status: 'invalid_order_number', instruction: 'Ask the customer for their order number (e.g. #1234), nothing else.' };
  if (lookupsSoFar >= MAX_ORDER_LOOKUPS) return { status: 'lookup_limit', instruction: 'No more order lookups in this conversation: invite the customer to use the contact form.' };
  if (!readOrder || !shopDomain) return { status: 'unavailable' };
  let row;
  try {
    row = await readOrder({ shopDomain, orderNumber });
  } catch {
    return { status: 'unavailable', looked_up: true };
  }
  if (!row) return { status: 'not_found', order: `#${orderNumber}`, looked_up: true, instruction: 'Say you cannot find this order number and invite them to check it or use the contact form.' };
  const params = knowledge?.parameters ?? new Map();
  const result = orderStatus(row, {
    dispatchDays: days(params, 'dispatch_days'),
    homeDeliveryDays: days(params, 'france_delivery_days'),
    abroadDeliveryDays: days(params, 'abroad_delivery_days'),
    homeCountry: HOME_COUNTRY,
  }, now);
  // The dispatch and delivery passages only (not the price or the countries served).
  const policy = knowledge ? getPolicy(knowledge, { topic: 'delivery', context: { query: 'délais expédition livraison' } }) : { status: 'unavailable' };
  return {
    ...result,
    looked_up: true,
    // The passages only: the reply explains the timing in the shop's words.
    policy: { status: policy.status, passages: (policy.sources ?? []).flatMap((s) => s.passages ?? []) },
    instruction: STATUS_INSTRUCTIONS[result.status],
  };
}

// What each status means for the reply. Always one or two sentences, then the contact form (shown by the app).
const STATUS_INSTRUCTIONS = {
  preparing: 'Not shipped yet and still within the usual dispatch time: say it is being prepared.',
  // « Je suis désolé(e) » is a gendered form the prompt forbids: the shop apologises as « nous ».
  dispatch_delayed: 'Not shipped and past the usual dispatch time: apologise for the delay, as the shop (« Toutes nos excuses pour ce retard », "We are sorry for the delay").',
  on_the_way: 'Shipped and still within the usual delivery time: say it is on its way.',
  delivery_late: 'Shipped and past the usual delivery time: apologise that it is late, as the shop (« Toutes nos excuses pour ce retard », "We are sorry it is late").',
  delivered: 'Recorded as delivered on delivered_on: say so.',
  cancelled: 'This order was cancelled: say so plainly.',
  timing_unknown: 'Give the status only; do not estimate any timing.',
};

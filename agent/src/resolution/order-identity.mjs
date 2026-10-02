import { CONFIRMED, MISMATCH, NAME_MATCH, NOT_FOUND } from './order-verification.mjs';

// WHICH OF THE ORDER-IDENTITY SITUATIONS A TICKET IS IN.
//
// Before this, every unconfirmed ticket was `order_identity: none`. A customer
// who quoted #6668 from another address, and one who gave nothing at all, read
// the same, so every rule on `none` asked for the order number AND the address.
// Found on real tickets: « Une rétrofacturation… #6668 » and « Remboursement de
// commande #6711 » were asked for the number they had just written.
//
// These values are what a rule in the Rulebook branches on. Each one wants a
// different question:
//
//   resolved                  — confirmed. Ask nothing.
//   no_number_known_sender    — no reference, but the sender is a customer of
//                               ours. Ask for the order number only.
//   no_number_unknown_sender  — no reference and no customer under this address.
//                               Ask for the number and the address.
//   number_not_found          — a reference was given and leads to no order (a
//                               typo, a warehouse `Q00…` reference, a parcel
//                               number we do not hold). Ask them to check it.
//   other_email_same_name     — the order exists under another address, same
//                               name: probably the same person's second mailbox.
//   other_email               — the order exists under another address and the
//                               name does not agree. Ask which address placed it.

export const ORDER_IDENTITY_SITUATIONS = [
  'resolved',
  'no_number_known_sender',
  'no_number_unknown_sender',
  'number_not_found',
  'other_email_same_name',
  'other_email'
];

/**
 * @param shopifyOrderNumber the ticket's confirmed order, or null
 * @param resolution `tickets.metadata.order_resolution`, or null if the pass has
 *   not run on this ticket yet
 * @param customerId `tickets.customer_id`: the sender is a known customer
 * @returns {{ situation: string, orderName: string|null }}. `orderName` is the
 *   order the customer's reference led to, set only where it exists.
 */
export function orderIdentitySituation({ shopifyOrderNumber = null, resolution = null, customerId = null } = {}) {
  if (shopifyOrderNumber) {
    return { situation: 'resolved', orderName: shopifyOrderNumber };
  }

  const status = resolution?.status ?? null;
  const found = resolution?.found_order_name ?? null;

  // A confirmed status with no number on the column is not a state the
  // resolver writes. It is read as "nothing usable" rather than trusted.
  if (status === CONFIRMED) {
    return noNumber(customerId);
  }

  // THE ORDER EXISTS; ONLY ITS OWNER IS IN DOUBT. A `not_found` can land here
  // too: the order exists but one side has no address to compare.
  // Metadata written before `found_order_name` existed carries a mismatch with
  // no name. It still means an order was found, and the next pass fills the name.
  if (found || status === MISMATCH || status === NAME_MATCH) {
    return {
      situation: status === NAME_MATCH ? 'other_email_same_name' : 'other_email',
      orderName: found
    };
  }

  if (status === NOT_FOUND || resolution?.unmatched_reference === true) {
    return { situation: 'number_not_found', orderName: null };
  }

  // `no_candidate`, or the pass has not reached this ticket yet. Both mean we
  // hold no reference, and whether the sender is known decides the question.
  return noNumber(customerId);
}

function noNumber(customerId) {
  return {
    situation: customerId ? 'no_number_known_sender' : 'no_number_unknown_sender',
    orderName: null
  };
}

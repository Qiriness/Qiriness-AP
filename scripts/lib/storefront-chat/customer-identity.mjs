import { createHmac } from 'node:crypto';

/**
 * Who the storefront advisor is talking to — purchase history, Phase 0
 * (docs/storefront-advisor-plan.md § 5, docs/decisions/storefront-advisor.md
 * § Purchase history: identity from the signature only).
 *
 * THE ONLY SOURCE IS THE SIGNED QUERY. Shopify's app proxy adds
 * `logged_in_customer_id` to every proxied request and signs it with the rest;
 * the route has already verified that signature. An email, an order number or a
 * `loggedIn` flag in the body proves nothing and is never read here.
 *
 * OFF BY DEFAULT. Unless `STOREFRONT_CHAT_PURCHASE_HISTORY=on`, every request is
 * anonymous and the customer id goes no further than this function.
 *
 * THE ID IS NEVER STORED. A conversation is bound to its customer by `ref`, an
 * HMAC of shop + id keyed with the app secret: stable for one customer of one
 * shop, meaningless without the secret (a bare hash of a sequential Shopify id
 * could be reversed by trying every id).
 */

/** Shopify customer ids are positive integers; anything else is no identity. */
const CUSTOMER_ID = /^[1-9]\d{0,19}$/;

export const ANONYMOUS = Object.freeze({ kind: 'anonymous' });

export function purchaseHistoryEnabled(env) {
  return String(env?.STOREFRONT_CHAT_PURCHASE_HISTORY ?? '').trim().toLowerCase() === 'on';
}

/**
 * @param {URLSearchParams} verifiedQuery a query whose app proxy signature has been verified
 * @param {{ shop: string, secret: string, env: object }} options
 * @returns {{ kind: 'anonymous' } | { kind: 'customer', shopifyCustomerId: string, ref: string }}
 */
export function customerIdentity(verifiedQuery, { shop, secret, env }) {
  if (!purchaseHistoryEnabled(env) || !secret || !shop) return ANONYMOUS;
  const id = String(verifiedQuery.get('logged_in_customer_id') ?? '').trim();
  if (!CUSTOMER_ID.test(id)) return ANONYMOUS;
  return { kind: 'customer', shopifyCustomerId: id, ref: identityRef(shop, id, secret) };
}

export function identityRef(shop, shopifyCustomerId, secret) {
  return createHmac('sha256', secret).update(`${String(shop).toLowerCase()}|${shopifyCustomerId}`).digest('hex').slice(0, 32);
}

/**
 * The customer a conversation belongs to: any assistant row's ref, or null
 * (anonymous throughout). Any row, not the latest: a reply written while the
 * setting was off carries none, and must not release the rows before it.
 */
export function identityOfHistory(history) {
  for (const row of history ?? []) {
    const ref = row?.role === 'assistant' ? row.context?.identity : null;
    if (typeof ref === 'string' && ref) return ref;
  }
  return null;
}

/**
 * May this request continue that conversation? The same identity may; an
 * anonymous conversation may be continued by a customer who has just signed in
 * (it holds nothing of anyone's purchases). A customer's conversation is never
 * continued by someone else or after signing out — on a shared device that
 * would show one person's purchases to the next.
 */
export function mayContinue(historyRef, identity) {
  if (!historyRef) return true;
  return identity.kind === 'customer' && identity.ref === historyRef;
}

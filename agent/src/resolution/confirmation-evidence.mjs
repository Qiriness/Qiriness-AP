import { hashIdentifier } from '../../../scripts/lib/compliance-audit.mjs';

// Evidence a customer supplies by forwarding their Shopify order confirmation.
//
// Pure: message text in, hashes and a diagnostic count out. No database, no
// judgement about what the evidence proves — that is order-verification's job.
//
// WHY THIS EXISTS. Measured over the mailbox, 18 inbound messages across 10
// tickets carry a pasted order confirmation. The order number parses out of all
// 18, but 3 of those tickets still ended with no `shopify_order_number`: the
// order exists and is registered to an address the sender did not write from, so
// verification returned `mismatch` and refused to write. The customer had
// forwarded the confirmation addressed to that very account — the proof was in
// the message and nothing was looking at it.
//
// WHY IT DOES NOT PARSE THE TEMPLATE, which is the whole design:
//
//   The obvious build is a parser for the confirmation's layout — find "N° de
//   commande", find the "Client" block, read the address underneath. That is the
//   shape contact-form.mjs has, and here it would be the wrong shape, because
//   the template is not what arrives. What arrives is the template after the
//   customer's mail client re-rendered it as a forward and after htmlToText
//   flattened it, and *then* after a merchant may have reworded it in Shopify's
//   notification settings. Every one of those three steps moves the labels.
//
//   There are no Shopify tags to key on either. The notification templates do
//   carry stable Liquid variables — `{{ order.name }}`, `{{ email }}`,
//   `{{ order.order_status_url }}` — but Liquid is rendered on Shopify's side
//   before the mail is sent, so the received message contains their VALUES and
//   never the tags. Nothing structural survives to be anchored on.
//
//   So this reads no structure. It takes every email address in the text,
//   whatever it is labelled and wherever it sits, and hashes it. The evidence is
//   not "this looks like a confirmation" — it is that the message contains an
//   order number AND, somewhere in it, the address that order is registered to.
//   Those two values must both be present for the evidence to exist at all, so
//   the check depends on nothing the template controls: it survives a reworded
//   label, a translated template, an Outlook forward that mangles the tables,
//   and a plain-text paste with the layout gone entirely.
//
//   It also catches more than it was built for, and that turned out to matter:
//   of the 6 tickets this rescues, only 3 carry a recognisable confirmation. The
//   other 3 quote the address some other way — a reply chain, or the customer
//   typing it out. A layout parser would have found 3 and called the rest
//   mismatches. Nothing here is named for the confirmation as a result.
//
// ONLY HASHES LEAVE THIS MODULE. `orders.customer_email_hash` and
// `tickets.requester_email_hash` are both sha256 of the trimmed lowercased
// address, so comparison never needs the raw value, and returning hashes keeps
// third-party addresses out of every caller, log line and metadata column.

/**
 * Addresses in an email body, matched loosely on both sides of the `@`. Kept
 * permissive because a false positive costs one hash that matches nothing,
 * while a miss costs the evidence.
 */
const EMAIL_PATTERN = /[^\s<>()[\],;:@]+@[^\s<>()[\],;:@]+\.[^\s<>()[\],;:@]+/g;

/**
 * Sentence-final punctuation clings to an address in prose (`écrit à
 * jean@x.fr.`) and would change the hash. Stripped from the end only — a dot is
 * legal inside both halves of a real address.
 */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"»>]+$/;

/**
 * A forwarded confirmation is a whole newsletter of addresses on a bad day.
 * Bounded so a pathological message cannot turn into thousands of hashes; far
 * above anything measured (the largest real confirmation carried 8).
 */
const MAX_ADDRESSES = 50;

/**
 * Every distinct address in the text, as hashes, in the order first seen.
 *
 * @param {string|null|undefined} text subject + body of the customer's message
 * @returns {string[]} sha256 hashes, comparable to `orders.customer_email_hash`
 */
export function messageEmailHashes(text) {
  const source = String(text || '');
  const seen = new Set();

  for (const match of source.matchAll(EMAIL_PATTERN)) {
    const address = match[0]
      .replace(/^mailto:/i, '')
      .replace(TRAILING_PUNCTUATION, '')
      .trim()
      .toLowerCase();
    // The pattern can match a bare `a@b` once punctuation is stripped.
    if (!address.includes('@') || !address.split('@')[1]?.includes('.')) {
      continue;
    }
    const hash = hashIdentifier(address);
    if (hash) {
      seen.add(hash);
    }
    if (seen.size >= MAX_ADDRESSES) {
      break;
    }
  }

  return [...seen];
}

/**
 * Markers that suggest the text contains an order confirmation at all.
 *
 * DIAGNOSTIC ONLY — deliberately not a gate. Nothing downstream is allowed to
 * depend on this count, because it is exactly the template-shaped reading the
 * module avoids: reword the notification and these go quiet. It exists so that
 * `metadata.order_resolution` can tell a human reviewing a written order number
 * *why* it was written, and so a drop in the count is visible as template drift
 * rather than as silent under-resolution.
 *
 * Multilingual because the mailbox is: the store sends French, but the customer
 * quoting it may be writing from a Spanish or English client that adds its own
 * forward furniture.
 */
const CONFIRMATION_MARKERS = [
  /\bn[°ºo]?\s*de commande\b/i,
  /\border number\b/i,
  /\bn[uú]mero de pedido\b/i,
  /description de votre commande/i,
  /order summary|resumen del pedido/i,
  /infos? de paiement|payment (info|details)|informaci[oó]n de pago/i,
  /sous-total|subtotal/i,
  /adresse de livraison|shipping address|direcci[oó]n de env[ií]o/i,
  /merci pour (votre|ta) commande|thank you for your (order|purchase)|gracias por tu (compra|pedido)/i,
  // The order-status link's own text. The href is dropped before storage, but
  // the anchor text survives the flattening.
  /voir (ma|votre) commande|view your order|ver (mi|tu) pedido/i
];

/**
 * How many independent confirmation markers the text carries.
 *
 * @param {string|null|undefined} text
 * @returns {number}
 */
export function countConfirmationMarkers(text) {
  const source = String(text || '');
  return CONFIRMATION_MARKERS.reduce((total, marker) => total + (marker.test(source) ? 1 : 0), 0);
}

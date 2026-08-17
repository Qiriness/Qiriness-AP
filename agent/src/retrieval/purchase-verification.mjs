// Can we place the person who wrote us, and does what they are describing match
// something they actually bought?
//
// THE POINT IS THE THIRD STATE. "Is this a customer" reads like a boolean and is
// not one, because the address a customer writes from is only evidence about the
// address. Three answers, and they lead to three different replies:
//
//   known_buyer      in `customers`, at least one order      -> answer normally
//   known_no_orders  in `customers`, zero orders             -> newsletter signup,
//                                                               or gave an email at
//                                                               a till. NOT a
//                                                               verified purchase
//   unknown          no match on the address at all          -> may well be a shop
//                                                               purchase, or a
//                                                               second address
//
// Collapsing the middle into either neighbour is the mistake this module exists
// to prevent: a newsletter subscriber is not a proven buyer, and a stranger is
// not proof that nothing was bought. **Neither of the two lower states is
// evidence that the person is not a customer** — only that this database cannot
// show it. Retail sales never reach Shopify at all, so absence here is silence,
// not denial, and every renderer below says so in words.
//
// WHY THE LAST ORDER, AND ONLY THE LAST ONE. Once the customer is known, their
// most recent order is the cheapest strong context available: it names two to
// five real products, and matching the customer's vague wording against THOSE
// beats matching it against the 116-product catalogue. It also stays inside the
// data-minimisation rule this codebase already keeps — one order, not a
// purchase history. The cost is real and stated: someone writing about a product
// bought three orders ago reads as `not_in_last_order`, which is why that
// outcome is worded as "not in their most recent order" and never as "they never
// bought this".
//
// Pure: rows in, a verdict out. No database, no clock, no Graph.

import { buildProductIndex, matchProduct } from './product-matching.mjs';

export const PURCHASE_STATES = ['known_buyer', 'known_no_orders', 'unknown'];

/**
 * Which of the three states this customer row represents.
 *
 * `number_of_orders` is Shopify's own lifetime count, so it stays correct for a
 * customer whose orders predate our sync window — which a join against the
 * `orders` table would not.
 */
export function purchaseState(customer) {
  if (!customer) return 'unknown';
  const orders = Number(customer.number_of_orders ?? 0);
  return orders > 0 ? 'known_buyer' : 'known_no_orders';
}

/** Whether an online purchase is established. False for both lower states. */
export function hasVerifiedPurchase(state) {
  return state === 'known_buyer';
}

/**
 * The line items of an order, as titles.
 *
 * Shopify's line item shape has moved around over the years and the snapshot
 * keeps whatever arrived, so this reads several spellings rather than assuming
 * one. A line with no title at all is dropped instead of becoming an empty
 * candidate that matches everything weakly.
 */
export function orderProductTitles(order) {
  const items = Array.isArray(order?.line_items) ? order.line_items : [];
  return items
    .map((item) => ({
      title: String(item?.title || item?.name || '').trim(),
      variant: item?.variant_title ? String(item.variant_title).trim() : null,
      quantity: Number(item?.quantity ?? 1) || 1
    }))
    .filter((item) => item.title.length > 0);
}

/**
 * Does the product the customer is describing appear in this order?
 *
 * IDF WEIGHTS COME FROM THE CATALOGUE, CANDIDATES COME FROM THE ORDER. Building
 * an index over three line items would make every token equally rare and turn
 * the score into plain word overlap — `creme` would count as much as `led`. So
 * the catalogue index is passed in for its `idf` map and only the entries are
 * swapped. That is why this takes `catalogueIndex` rather than building its own.
 *
 * Returns `undetermined` rather than a guess whenever the question carries no
 * usable product words, because "they did not name a product" and "they named
 * one we did not sell them" are different findings.
 */
export function matchQuestionToOrder(question, order, catalogueIndex = null) {
  const products = orderProductTitles(order);
  if (products.length === 0) {
    return { verdict: 'undetermined', reason: 'no_line_items', matched: null, products };
  }

  const entries = buildProductIndex(products).entries;
  // Keep the catalogue's IDF when we have one; fall back to the order's own,
  // which is degenerate but never wrong, only blunt.
  const index = { entries, idf: catalogueIndex?.idf ?? buildProductIndex(products).idf };

  const result = matchProduct(question, index);

  // AMBIGUITY IS CHECKED FIRST, and the order is load-bearing: `matchProduct`
  // returns `match: null` when two candidates tie, precisely so a caller reading
  // only `match` cannot silently receive one of two. Testing `!result.match`
  // first would read that tie as "nothing matched" and report the customer's
  // product as absent from an order that in fact contains both candidates.
  if (result.ambiguous) {
    const tied = result.tied.map((product) => product.title);
    return {
      verdict: 'ambiguous',
      reason: null,
      matched: tied[0] ?? null,
      confidence: result.confidence,
      tied: tied.slice(1),
      products
    };
  }

  if (!result.match) {
    return {
      verdict: 'not_in_last_order',
      reason: 'no_candidate_scored',
      matched: null,
      tied: [],
      products
    };
  }

  return {
    verdict: 'in_last_order',
    reason: null,
    matched: result.match.title,
    confidence: result.confidence,
    tied: [],
    products
  };
}

/**
 * The whole answer: who they are, and whether the product fits what they bought.
 *
 * The product check is only attempted for a `known_buyer` with an order to check
 * against. Running it for the other two states would produce
 * `not_in_last_order` on every unverified sender and read as a contradiction of
 * the customer, when the truth is that there is no order here to compare with.
 */
export function verifyPurchase({ customer, lastOrder = null, question = '', catalogueIndex = null }) {
  const state = purchaseState(customer);

  if (!hasVerifiedPurchase(state) || !lastOrder) {
    return {
      state,
      verified: false,
      lastOrder: null,
      product: { verdict: 'undetermined', reason: 'no_verified_order', matched: null, products: [] }
    };
  }

  return {
    state,
    verified: true,
    lastOrder: {
      name: lastOrder.name ?? null,
      processedAt: lastOrder.processed_at ?? null,
      products: orderProductTitles(lastOrder)
    },
    product: matchQuestionToOrder(question, lastOrder, catalogueIndex)
  };
}

/**
 * The French line the model is shown.
 *
 * Every unverified wording is phrased as **what we cannot show, not what is not
 * true**. A retail purchase leaves no trace in Shopify, so "aucune commande
 * trouvée" must never be rendered as "cette personne n'est pas cliente" — that
 * is the specific false claim this whole module exists to keep out of a reply.
 *
 * No order number, no address, no spend: the caller already has the customer
 * bundle for anything more, and repeating it here would widen the prompt's
 * personal data for nothing.
 */
export function toPromptText(verification) {
  if (!verification) return 'Achat : non vérifié.';

  const lines = [];

  switch (verification.state) {
    case 'known_buyer':
      lines.push('Client identifié : oui, avec au moins une commande en ligne.');
      break;
    case 'known_no_orders':
      lines.push(
        'Client identifié : cette adresse existe dans la base client, mais aucune ' +
          'commande en ligne n’y est rattachée (inscription newsletter, ou adresse ' +
          'donnée en boutique). L’achat n’est PAS vérifié.'
      );
      break;
    default:
      lines.push(
        'Client identifié : non. Aucune fiche client ne correspond à cette adresse. ' +
          'Cela ne prouve pas qu’il n’y a pas eu d’achat — un achat en boutique ' +
          'physique n’apparaît jamais ici.'
      );
  }

  if (!verification.verified) {
    lines.push('Achat en ligne non confirmé : demander s’il s’agit d’un achat en boutique.');
    return lines.join(' ');
  }

  const { product, lastOrder } = verification;
  const titles = (lastOrder?.products ?? []).map((item) => item.title).join(', ');

  switch (product.verdict) {
    case 'in_last_order':
      lines.push(`Dernière commande : ${titles}. Le produit évoqué (${product.matched}) y figure.`);
      break;
    case 'ambiguous':
      lines.push(
        `Dernière commande : ${titles}. Plusieurs produits correspondent à la description ` +
          `(${[product.matched, ...(product.tied ?? [])].join(', ')}) : demander lequel.`
      );
      break;
    case 'not_in_last_order':
      lines.push(
        `Dernière commande : ${titles}. Le produit évoqué n’y figure pas — il peut venir ` +
          'd’une commande antérieure ou d’un achat en boutique.'
      );
      break;
    default:
      lines.push(`Dernière commande : ${titles}. Aucun produit identifiable dans le message.`);
  }

  return lines.join(' ');
}

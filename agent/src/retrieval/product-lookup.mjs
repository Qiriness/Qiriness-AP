import { supabaseSelectAll } from '../../../scripts/lib/supabase-rest-client.mjs';

import { buildProductIndex, matchProduct } from './product-matching.mjs';
import { buildProductContext, buildStock, toPromptText } from './product-context.mjs';

/**
 * Renders one product, or several with the ambiguity stated up front.
 *
 * The preamble is not decoration: without it a model handed two `# Title`
 * blocks tends to treat the first as the answer and the second as extra detail,
 * which is precisely the silent pick this exists to prevent. Saying "two
 * products match, we do not know which" makes asking the natural next move.
 */
function renderProducts(contexts, ambiguous) {
  if (!ambiguous || contexts.length < 2) {
    return toPromptText(contexts[0]);
  }
  const titles = contexts.map((c) => `« ${c.title} »`).join(' et ');
  return (
    `Attention : la demande peut correspondre à ${contexts.length} produits — ${titles}. ` +
    `Le produit exact n'est pas identifiable à partir du message.\n\n` +
    `${'='.repeat(60)}\n\n` +
    contexts.map(toPromptText).join(`\n\n${'='.repeat(60)}\n\n`)
  );
}

// Two tools over the product catalogue, sharing one matcher.
//
//   lookupProduct(question)  -> the full answer sheet for the product asked about
//   lookupStock(question)    -> that product's availability, and nothing else
//
// WHY TWO AND NOT ONE WITH A FLAG. They answer different questions and should
// cost differently. "Est-il encore disponible ?" needs one integer; returning
// the ingredients, the FAQ and every variant alongside it is a few thousand
// wasted tokens on every stock check, and gives a drafting model material it was
// not asked to use. Progressive retrieval, per AGENTS.md.
//
// The catalogue is 16 rows, so the title index is built once per instance and
// held. A `refresh()` exists for the long-running worker; nothing here assumes
// the process is short-lived.

const TITLE_COLUMNS = 'id,title,handle,status';

const CONTEXT_COLUMNS = [
  'id', 'title', 'handle', 'status', 'available_stock',
  'description', 'short_description',
  'usage_instructions', 'usage_advice',
  'active_ingredients', 'ingredients_popup', 'product_ingredients',
  'product_faqs', 'variants'
].join(',');

export function createProductLookup({ supabase, shopId, logger }) {
  let indexPromise = null;

  /**
   * Only id/title/handle/status are loaded to match on — never the descriptions
   * and rich-text blobs. Matching reads titles; pulling the row is a second,
   * narrow query for the one product that won.
   *
   * ACTIVE PRODUCTS ONLY, and this is not a detail. Measured against a real
   * ticket — "avant de vous acheter le coffret Caresse Temps sublime jour et
   * nuit" — the catalogue's `unlisted` sample "Caresse Temps Sublime Nuit -
   * échantillon" won at 0.88, because a short title is mostly covered by any
   * question naming it. The customer was asking about an €89.50 coffret and
   * would have been answered about a free sample. Drafts, archived items and
   * samples are not things a customer can be asking to buy, so they are not
   * candidates; excluding them also lets the two genuine coffrets tie and be
   * reported as ambiguous, which is the honest answer to that question.
   */
  function loadIndex() {
    if (!indexPromise) {
      indexPromise = supabaseSelectAll(
        supabase,
        'products',
        {
          shop_id: shopId,
          deleted_at: { operator: 'is', value: 'null' },
          status: 'active'
        },
        TITLE_COLUMNS
      ).then((products) => buildProductIndex(products));
    }
    return indexPromise;
  }

  async function resolve(question, options) {
    const index = await loadIndex();
    const result = matchProduct(question, index, options);

    logger?.info?.('product.match', {
      matched: result.match ? result.match.title : null,
      confidence: Number(result.confidence.toFixed(3)),
      ambiguous: result.ambiguous,
      candidates: result.candidates.length
    });

    return result;
  }

  async function fetchRow(productId, columns) {
    const rows = await supabaseSelectAll(supabase, 'products', { id: productId }, columns);
    return rows[0] || null;
  }

  return {
    /** Drops the cached title index — call after a product sync. */
    refresh() {
      indexPromise = null;
    },

    /**
     * Full product context for a specific-product question.
     *
     * WHEN THE NAME IS AMBIGUOUS, BOTH ARE RETURNED. Silently picking one is the
     * dangerous case — the wrong ingredient list in a reply to someone asking
     * about an allergy — but withholding both is merely unhelpful, and there is
     * no reason to be unhelpful. "Le coffret Caresse Temps Sublime" genuinely
     * names two products; handing over both, clearly separated and flagged, lets
     * the reply either cover both or ask a question that already contains the
     * information. `products` is always the array; `product` is set only when
     * there is one answer, so a caller reading it cannot get a coin flip.
     */
    async lookupProduct(question, options = {}) {
      const { match, confidence, ambiguous, tied, candidates } = await resolve(question, options);
      const chosen = match ? [match] : tied;

      if (chosen.length === 0) {
        return {
          found: false,
          ambiguous: false,
          reason: 'no_match',
          products: [],
          candidates: candidates.map((c) => c.product.title)
        };
      }

      const rows = await Promise.all(chosen.map((p) => fetchRow(p.id, CONTEXT_COLUMNS)));
      const contexts = rows.filter(Boolean).map(buildProductContext);

      if (contexts.length === 0) {
        return { found: false, ambiguous: false, reason: 'no_match', products: [], candidates: [] };
      }

      return {
        found: true,
        ambiguous,
        confidence,
        products: contexts,
        // Only when there is a single answer. Deliberately absent on ambiguity.
        product: ambiguous ? undefined : contexts[0],
        promptText: renderProducts(contexts, ambiguous)
      };
    },

    /**
     * Availability only. Same matcher, one integer of payload per product.
     *
     * Ambiguity is answered rather than refused here even more readily than
     * above: two stock numbers cost nothing, and "Coffret Source d'Eau: rupture;
     * Caresse Source d'Eau: en stock" is a genuinely useful reply where "which
     * do you mean?" is just another round trip.
     */
    async lookupStock(question, options = {}) {
      const { match, confidence, ambiguous, tied, candidates } = await resolve(question, options);
      const chosen = match ? [match] : tied;

      if (chosen.length === 0) {
        return {
          found: false,
          ambiguous: false,
          reason: 'no_match',
          products: [],
          candidates: candidates.map((c) => c.product.title)
        };
      }

      const rows = await Promise.all(
        chosen.map((p) => fetchRow(p.id, 'id,title,status,available_stock'))
      );
      const products = rows.filter(Boolean).map((row) => ({ title: row.title, ...buildStock(row) }));

      if (products.length === 0) {
        return { found: false, ambiguous: false, reason: 'no_match', products: [], candidates: [] };
      }

      return {
        found: true,
        ambiguous,
        confidence,
        products,
        // Flattened for the single-product case, so the common path stays simple.
        ...(ambiguous ? {} : products[0])
      };
    }
  };
}

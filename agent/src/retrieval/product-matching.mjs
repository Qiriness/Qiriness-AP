// Finds which product a customer is asking about, from the product TITLE only.
//
// WHY TITLE ONLY, and why not embeddings. A specific product question —
// "vos produits gamme active énergie sont-ils sans parfum ?" — is answered by
// that product's row, not by a knowledge article: the ingredients, the usage
// instructions and the product FAQ already live in `products`. The hard part is
// only deciding WHICH product, and that is a name-matching problem, not a
// semantic-similarity one. Searching descriptions too would be actively worse:
// every anti-âge product's description mentions every other concern, so the
// distinguishing signal is precisely the name.
//
// Pure: index in, question in, ranked candidates out. No database, no model.

/**
 * Common words carry no product identity. French support mail is full of them,
 * and left in they let "la crème" weakly match half the catalogue.
 *
 * Deliberately small and general — it is a stopword list, not a synonym table.
 * Product vocabulary (crème, coffret, masque) is NOT listed here: those words do
 * distinguish products, just weakly, and the IDF weighting below already handles
 * "appears in half the titles" far better than a hand-kept list would.
 */
const STOPWORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'd', 'l',
  'et', 'ou', 'a', 'au', 'aux', 'en', 'pour', 'par', 'avec', 'sans',
  'sur', 'dans', 'the', 'and', 'of', 'votre', 'vos', 'mon', 'ma', 'mes',
  'ce', 'cet', 'cette', 'je', 'vous', 'il', 'elle', 'est', 'sont'
]);

/**
 * Lowercase, strip accents, and normalise the punctuation Shopify titles are
 * full of. Real titles carry `’`, `–` and `®`; real customers type `'` and `-`
 * or nothing at all, so "Source d’Eau" and "source d'eau" must reach the same
 * tokens or nothing matches.
 */
export function normalise(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics: Éclat -> eclat
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/[^a-z0-9'\-\s]/g, ' ') // ®, &, punctuation
    .replace(/[''\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenise(text) {
  return normalise(text)
    .split(' ')
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

/**
 * Precomputes tokens and inverse document frequency across the catalogue.
 *
 * IDF is what makes this work without a synonym list. `creme` appears in a third
 * of the titles and so barely moves a score; `led` appears in exactly one and is
 * nearly decisive. That is the correct relative weighting and it maintains
 * itself as the catalogue changes — a hand-tuned list would not.
 */
export function buildProductIndex(products) {
  const entries = products.map((product) => ({
    product,
    tokens: new Set(tokenise(product.title))
  }));

  const documentFrequency = new Map();
  for (const entry of entries) {
    for (const token of entry.tokens) {
      documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
  }

  const total = Math.max(entries.length, 1);
  const idf = new Map();
  for (const [token, count] of documentFrequency) {
    // +1 inside the log keeps every weight positive: a token in *every* title
    // should count for almost nothing, never zero, or a title made entirely of
    // common words could never be matched at all.
    idf.set(token, Math.log(1 + total / count));
  }

  return { entries, idf };
}

/**
 * Ranks products against a question.
 *
 * MATCHED BOTH WAYS, because either direction alone is wrong:
 *  - `titleCoverage` — how much of the product's name the question actually
 *    said. Alone it favours short titles: a question mentioning "eau" would
 *    score well against a two-word product.
 *  - `phrase` — whether the question contains the title's words contiguously,
 *    which separates "le masque LED" from a question that merely happens to use
 *    the words "masque" and "LED" about different things.
 *
 * AMBIGUITY IS AN OUTCOME, not a tiebreak. "le coffret Caresse Temps Sublime"
 * genuinely matches two real products; picking one and pulling its ingredients
 * into a reply would confidently answer about the wrong item. When the runner-up
 * is within `ambiguityMargin`, the caller is told so and should ask.
 */
export function matchProduct(question, index, { minScore = 0.35, ambiguityMargin = 0.12, limit = 3 } = {}) {
  const questionTokens = new Set(tokenise(question));
  const normalisedQuestion = ` ${normalise(question)} `;

  if (questionTokens.size === 0 || index.entries.length === 0) {
    return { match: null, confidence: 0, ambiguous: false, tied: [], candidates: [] };
  }

  const scored = index.entries
    .map((entry) => {
      let matchedWeight = 0;
      let totalWeight = 0;
      const matched = [];

      for (const token of entry.tokens) {
        const weight = index.idf.get(token) ?? 1;
        totalWeight += weight;
        if (questionTokens.has(token)) {
          matchedWeight += weight;
          matched.push(token);
        }
      }

      const titleCoverage = totalWeight > 0 ? matchedWeight / totalWeight : 0;
      // A contiguous run of the title's distinctive words appearing verbatim is
      // the strongest signal available, and cheap to check.
      const phrase = hasPhraseOverlap(normalisedQuestion, entry.product.title);
      const score = Math.min(1, titleCoverage + (phrase ? 0.15 : 0));

      return {
        product: entry.product,
        score,
        titleCoverage,
        phrase,
        matchedTokens: matched
      };
    })
    .filter((candidate) => candidate.score >= minScore)
    .sort((a, b) => b.score - a.score || b.matchedTokens.length - a.matchedTokens.length);

  if (scored.length === 0) {
    return { match: null, confidence: 0, ambiguous: false, tied: [], candidates: [] };
  }

  const [best] = scored;
  // Everything close enough to the leader to be a genuine reading of the
  // question, not just the ranked list. The caller answers for all of them.
  const tied = scored.filter((c) => best.score - c.score < ambiguityMargin).slice(0, limit);
  const ambiguous = tied.length > 1;

  return {
    // Still null when ambiguous: there is no single answer, and a caller that
    // reads only `match` must not silently get one of two.
    match: ambiguous ? null : best.product,
    confidence: best.score,
    ambiguous,
    tied: tied.map((c) => c.product),
    candidates: scored.slice(0, limit).map((c) => ({
      product: c.product,
      score: Number(c.score.toFixed(3)),
      matchedTokens: c.matchedTokens
    }))
  };
}

/** Does the question contain at least two of the title's words, adjacent? */
function hasPhraseOverlap(normalisedQuestion, title) {
  const words = tokenise(title);
  for (let i = 0; i < words.length - 1; i += 1) {
    if (normalisedQuestion.includes(` ${words[i]} ${words[i + 1]} `)) {
      return true;
    }
  }
  return false;
}

// Finds which product a customer is asking about, from the product TITLE only.
//
// FOUR SHAPES, NOT TWO. A product question is not always about one product, and
// treating it as though it were is what produced the failures this module was
// rewritten for:
//
//   a product   « la Crème Yeux Anti-Âge Regard d'Exception »   -> `match`
//   a range     « la gamme Temps Sublime convient-elle… »       -> `range`
//   ambiguity   « le coffret Caresse Temps Sublime jour/nuit »  -> `ambiguous`
//   nothing     « vos produits sont-ils testés sur les animaux » -> `reason`
//
// The device-versus-cosmetic case needs no rule of its own: `led` is in one of
// 98 titles, so IDF makes it nearly decisive, and « masque » alone spans fifteen
// and settles nothing. That is the weighting doing exactly its job.
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
 * Is this something a customer could be asking about?
 *
 * SAMPLES ARE NOT, and leaving them in was the single biggest matching defect on
 * this catalogue. Their titles are the range name plus « échantillon » — short,
 * so almost fully covered by any question naming the range — and eight of them
 * are `active`, so the status filter never touched them. « Caresse Temps Sublime
 * - échantillon » outranked both real coffrets on « j'ai commandé le coffret
 * Caresse Temps Sublime », and « gamme active énergie » resolved to a sample too.
 *
 * A customer cannot buy one, cannot have ordered one on its own, and never asks
 * a question about one. Excluding them is not a ranking tweak — it removes rows
 * that should never have been candidates.
 */
export function isCustomerFacing(product) {
  return String(product?.product_type ?? '').trim().toUpperCase() !== 'SAMPLE PRODUCT';
}

/**
 * Precomputes tokens, inverse document frequency, and the ranges, once.
 *
 * IDF is what makes this work without a synonym list. `creme` appears in a third
 * of the titles and so barely moves a score; `led` appears in exactly one and is
 * nearly decisive. That is the correct relative weighting and it maintains
 * itself as the catalogue changes — a hand-tuned list would not.
 *
 * The ranges are computed here rather than per question because they are a
 * property of the catalogue, not of what was asked, and the index is already the
 * thing rebuilt after a product sync.
 */
export function buildProductIndex(products) {
  const entries = products.filter(isCustomerFacing).map((product) => ({
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

  const weights = entries
    .map((entry) => [...entry.tokens].reduce((sum, token) => sum + (idf.get(token) ?? 1), 0))
    .sort((a, b) => a - b);

  return {
    entries,
    idf,
    saturation: medianOf(weights),
    ranges: buildRanges(entries, idf)
  };
}

/**
 * The title weight past which covering more of a name says nothing more.
 *
 * THE MEDIAN TITLE, because identification does not need a whole title — only
 * enough of it that no other product fits. Coverage divides by the full title, so
 * a name carrying a marketing tail becomes *harder* to say correctly: « Déodorant
 * Bille Anti-transpirant 48H - Fleur d'Oranger 100% Naturel - Roll On - Sans
 * Alcool » is 51 weight over twelve tokens, and a customer writing « le déodorant
 * fleur d'oranger » covered 13.5 of it — 0.265, which scored BELOW vague
 * questions naming no product at all (« un masque pour le visage », 0.280). The
 * ranking was inverted, not merely low.
 *
 * Derived rather than chosen, so it tracks the catalogue instead of dating. It
 * binds only on titles longer than typical — the defect class — and leaves every
 * shorter title scoring exactly as before. That also keeps it safe under
 * `matchQuestionToOrder`, where the index is the two or three lines of one order
 * and the median sits next to both, so the cap effectively never applies.
 */
function medianOf(sorted) {
  if (sorted.length === 0) return Infinity;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * How many titles a phrase must span before it is a range rather than a name.
 *
 * TWO, because that is what a range is on this catalogue: « Temps Sublime »
 * covers a coffret and a duo, « Active Énergie » a serum and a cream. Requiring
 * three would miss most of them; one would make every product its own range.
 */
const MIN_RANGE_MEMBERS = 2;

/**
 * Above this, the leader is the answer and a close runner-up does not matter.
 *
 * 0.55 sits between the two bands measured over 50 real phrasings — genuine ties
 * peak at 0.509, clear winners start at 0.598 — and deliberately nearer the tie
 * band. See the calibration note in `matchProduct`.
 */
const CLEAR_MATCH = 0.55;

/**
 * Scores this close are the same score, and always a tie.
 *
 * INDEPENDENT OF THE CATALOGUE SIZE, which is why it exists alongside
 * `CLEAR_MATCH`. That threshold was calibrated against 98 titles; this function
 * is also used to score a question against the handful of line items in one
 * order, where everything scores high and an absolute bar means nothing. Two
 * candidates separated by less than this are indistinguishable however confident
 * the leader looks.
 */
const EXACT_TIE_GAP = 0.02;

/**
 * The distinctive phrases that name a family of products.
 *
 * DERIVED FROM THE TITLES, NOT LISTED. « gamme » appears in **zero** of the 98
 * titles — a range has no marker in the data, it is simply a phrase several
 * products share. Computing that from the catalogue means a range launched next
 * season is understood the day it syncs, where a hand-kept list would be wrong
 * from the first product added to it.
 *
 * ADJACENT PAIRS, NOT SINGLE WORDS. « caresse » alone spans nine products that
 * are not one range, and « creme » spans twenty-seven that are not any range.
 * The pair is what carries the identity — « caresse regard » and « caresse temps
 * sublime » are different families sharing a first word.
 *
 * WEIGHTED BY THE RAREST HALF OF THE PAIR, so a pair of common words cannot
 * become a range: « soin visage » spans dozens of titles and identifies nothing.
 */
function buildRanges(entries, idf) {
  const byPhrase = new Map();

  for (const entry of entries) {
    const words = tokenise(entry.product.title);
    // A title's own bigrams, de-duplicated: a phrase repeated in one title is
    // still one title's worth of evidence.
    const seen = new Set();
    for (let i = 0; i < words.length - 1; i += 1) {
      const phrase = `${words[i]} ${words[i + 1]}`;
      if (seen.has(phrase)) continue;
      seen.add(phrase);
      if (!byPhrase.has(phrase)) byPhrase.set(phrase, []);
      byPhrase.get(phrase).push(entry.product);
    }
  }

  const ranges = new Map();
  for (const [phrase, products] of byPhrase) {
    if (products.length < MIN_RANGE_MEMBERS) continue;
    const [a, b] = phrase.split(' ');
    // The pair is only distinctive if at least one half is. `Math.max` rather
    // than an average: « temps sublime » earns its place on `sublime` even
    // though `temps` is unremarkable.
    const weight = Math.max(idf.get(a) ?? 0, idf.get(b) ?? 0);
    if (weight < RANGE_MIN_IDF) continue;
    ranges.set(phrase, products);
  }
  return ranges;
}

/**
 * How distinctive the rarer half of a pair must be.
 *
 * `Math.log(1 + total / count)` on a 98-title catalogue gives ~0.7 to a word in
 * half the titles and ~2.5 to one in eight. 1.2 sits between: it admits « temps
 * sublime » and « active energie » and rejects « soin visage » and « creme
 * hydratante », which name a category rather than a family.
 */
const RANGE_MIN_IDF = 1.2;

/**
 * The words that say "I mean the family, not one item".
 *
 * Accent-folded, because `normalise` has already stripped them by the time these
 * are compared. Kept deliberately tight: every one of these is unambiguous about
 * scope, and a looser cue like « les » would turn most plurals into range
 * questions.
 */
const RANGE_CUES = ['gamme', 'ligne', 'collection', 'famille', 'coffrets', 'toute'];

/**
 * Above this confidence, a named product beats a named family.
 *
 * BOTH SIGNALS CAN BE PRESENT — « la crème nuit Caresse Temps Sublime de la
 * gamme anti-âge » says `gamme` and also spells out one item. Measured:
 *
 *     la gamme Temps Sublime convient-elle…          0.40   the family
 *     la crème nuit Caresse Temps Sublime, gamme…    0.76   one product
 *
 * Below 0.7 the cue is the stronger signal; above it the customer has named an
 * item and « gamme » was scene-setting.
 */
const RANGE_YIELDS_TO = 0.7;

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
    return { match: null, confidence: 0, ambiguous: false, range: null, reason: 'no_product_named', tied: [], candidates: [] };
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

      // Capped at the median title (see `medianOf`): past that, more of a name is
      // redundant to identifying it, and dividing by all of it penalises a product
      // for how verbosely it was named.
      const denominator = Math.min(totalWeight, index.saturation ?? Infinity);
      const titleCoverage = denominator > 0 ? Math.min(1, matchedWeight / denominator) : 0;
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
    // TWO WAYS TO MATCH NOTHING, AND THEY ARE OPPOSITE REPLIES. « Vos produits
    // sont-ils testés sur les animaux ? » names no product and wants a shop-wide
    // answer; « j'ai retrouvé un lait solaire Caresse soleil suprême » reaches
    // for one and misses. Asking « de quel produit s'agit-il ? » is right for the
    // second and wrong for the first, and one reason code cannot tell them apart.
    //
    // `partial_match` CLAIMS ONLY WHAT IT MEASURES: the question overlaps the
    // catalogue's vocabulary and still did not resolve. It is deliberately NOT
    // called `not_in_catalogue`, because a product the shop never listed shares
    // no words with any title and therefore looks exactly like a question that
    // named nothing. That case lands in `no_product_named`, and no scoring of
    // titles could put it anywhere else — the limit is in the signal, not the
    // threshold.
    return {
      match: null,
      confidence: 0,
      ambiguous: false,
      range: null,
      reason:
        bestCoverage(questionTokens, index) >= NAMED_SOMETHING_FLOOR
          ? 'partial_match'
          : 'no_product_named',
      tied: [],
      candidates: []
    };
  }

  const [best] = scored;
  // Everything close enough to the leader to be a genuine reading of the
  // question, not just the ranked list. The caller answers for all of them.
  const tied = scored.filter((c) => best.score - c.score < ambiguityMargin).slice(0, limit);

  // AMBIGUITY NEEDS A WEAK LEADER, NOT JUST A CLOSE RUNNER-UP — and the gap
  // alone was the wrong signal. Measured over 50 real phrasings, seven questions
  // that named a product plainly were reported as ties with the CORRECT product
  // ranked first: « la crème mains velours », « la brume sensi zen », « la crème
  // de nuit caresse temps sublime » and four more. Each lost a right answer to a
  // runner-up sharing one distinctive word.
  //
  // Neither the absolute gap nor the relative gap separates those from a real
  // tie — both overlap. The leader's own score does, cleanly:
  //
  //     a clear winner     0.598 … 0.912   (10 cases)
  //     a genuine tie      0.239 … 0.509   ( 4 cases)
  //
  // Which reads as what it is: a customer who named a product covers most of its
  // title, and a customer asking « je cherche une crème hydratante » covers a
  // third of several. The gap still decides among the vague ones.
  //
  // TIGHT, AND CALIBRATED ON FOURTEEN POINTS. It sits nearer the tie band than
  // the winner band on purpose — the cost of a wrong tie is asking a question
  // that did not need asking, and the cost of a wrong match is the wrong
  // ingredient list in front of somebody asking about an allergy.
  //
  // A NEAR-EXACT TIE OVERRIDES IT, and that clause exists because a test caught
  // the calibration being wrong. `CLEAR_MATCH` was measured against the 98-title
  // catalogue; `matchQuestionToOrder` borrows this same function to score a
  // question against the two or three line items of ONE ORDER, where every score
  // is high because the candidate set is tiny. An order holding « Sérum Temps
  // Sublime » and « Masque Temps Sublime », asked about « Temps Sublime », scores
  // both identically — and a confident-looking leader would have picked one.
  //
  // So: two candidates that score the same are a tie whatever the number says.
  // 0.02 separates every real tie measured (gaps of 0.000, 0.006 and 0.012) from
  // every clear winner (0.030 and up).
  const gap = tied.length > 1 ? best.score - tied[1].score : 1;
  const ambiguous = tied.length > 1 && (gap < EXACT_TIE_GAP || best.score < CLEAR_MATCH);

  // A RANGE IS AN INTENT, READ FROM THE QUESTION, not a fallback for a weak
  // match. The customer who writes « la gamme Temps Sublime convient-elle aux
  // peaux sensibles ? » is asking about a family, and answering about whichever
  // member happened to score highest answers a narrower question than the one
  // asked — even when that member wins outright, which it does.
  //
  // IT YIELDS TO A CONFIDENT MATCH, because a cue and a specific product can
  // both be present. Measured on the fixture catalogue:
  //
  //     la gamme Temps Sublime convient-elle…            0.40  <- the family
  //     la crème nuit Caresse Temps Sublime, gamme…      0.76  <- one product
  //
  // Below the floor the cue is the stronger signal; above it the customer has
  // spelled out an item and « gamme » was scene-setting.
  const range =
    best.score < RANGE_YIELDS_TO ? rangeNamedBy(question, index, scored) : null;

  return {
    // Null when ambiguous AND when a range answered, for the same reason: a
    // caller that reads only `match` must never silently get one product where
    // the honest answer was two candidates or a whole family.
    match: ambiguous || range ? null : best.product,
    confidence: best.score,
    // A resolved range is no longer an ambiguity — it is an answer of a
    // different shape, and a caller branching on `ambiguous` must not ask the
    // customer to choose between products they were not choosing between.
    ambiguous: ambiguous && !range,
    range,
    tied: tied.map((c) => c.product),
    candidates: scored.slice(0, limit).map((c) => ({
      product: c.product,
      score: Number(c.score.toFixed(3)),
      matchedTokens: c.matchedTokens
    }))
  };
}

/**
 * Below this, the question was not pointing at any product.
 *
 * MEASURED, AND THE BANDS OVERLAP — which is why this is a floor and not a
 * claim. Raw best coverage on real questions:
 *
 *     vos produits sont-ils testés sur les animaux ?     0.000
 *     100% de vos produits sont-ils vegan ?              0.088
 *     faire évoluer ma routine de soins du visage        0.202   <- named nothing
 *     un lait solaire Caresse soleil suprême             0.219   <- named something
 *     le mode pulsé sur le masque qiriness               0.250   <- named something
 *     la Crème Yeux Anti-Âge Regard d'Exception          1.000
 *
 * 0.15 separates the shop-wide questions cleanly and puts the advice question on
 * the wrong side of the line, because « routine de soins du visage » genuinely
 * shares vocabulary with the titles. That miscall is cheap: an advice question is
 * `recommendProducts`' job, and this tool reporting "you named something we
 * cannot place" about it changes no reply. Separating them properly would need
 * to know that « routine » is a request and « lait solaire » is a noun, which is
 * not something a token score can tell.
 */
const NAMED_SOMETHING_FLOOR = 0.15;

/**
 * A first, unthresholded pass: how much of the best-covered title the question
 * actually said.
 *
 * ITS ONLY JOB IS TELLING THE TWO EMPTY ANSWERS APART. « Vos produits sont-ils
 * testés sur les animaux ? » names no product and wants a shop-wide reply;
 * « j'ai retrouvé un lait solaire Caresse soleil suprême » names one precisely,
 * and that product is not in the catalogue at all — asking « de quel produit
 * s'agit-il ? » is the wrong reply to the first and the right one to neither.
 */
function bestCoverage(questionTokens, index) {
  let best = 0;
  for (const entry of index.entries) {
    let matched = 0;
    let total = 0;
    for (const token of entry.tokens) {
      const weight = index.idf.get(token) ?? 1;
      total += weight;
      if (questionTokens.has(token)) matched += weight;
    }
    if (total > 0) best = Math.max(best, matched / total);
  }
  return best;
}

/**
 * The range the tied products all belong to, or null.
 *
 * ALL OF THEM, NOT MOST. A range that covers two of three tied products has not
 * explained the third, and answering about the family would silently drop it —
 * so the ambiguity stands and the customer is asked, which is what an unexplained
 * candidate means.
 *
 * THE PHRASE MUST BE IN THE QUESTION. A family the customer never named is not
 * what they asked about: two products can share « source d'eau » and be tied on
 * a question that says neither word, and calling that a range question would
 * invent an intent from the catalogue's own naming.
 */
function rangeNamedBy(question, index, scored) {
  if (!index.ranges) {
    return null;
  }
  const asked = ` ${normalise(question)} `;

  // THE QUESTION MUST SAY IT IS ABOUT A FAMILY, and this is the guard that keeps
  // the feature from eating ordinary ambiguity. « Le coffret Caresse Temps
  // Sublime jour et nuit » names a family phrase and is asking about ONE PRODUCT;
  // treating it as a range because two products share those words would answer a
  // question nobody asked, and lose the ambiguity that should have been put back
  // to the customer.
  //
  // A SHORT CLOSED LIST, WHICH IS UNUSUAL HERE AND UNAVOIDABLE. Everything else
  // in this file derives its vocabulary from the catalogue; « gamme » cannot,
  // because it appears in **zero** of the 98 titles. These are French words about
  // families of products, not catalogue content, so there is nothing to derive
  // them from.
  if (!RANGE_CUES.some((cue) => asked.includes(` ${cue} `))) {
    return null;
  }
  let found = null;
  for (const [phrase, products] of index.ranges) {
    if (!asked.includes(` ${phrase} `)) continue;
    // The widest family the question named: « temps sublime » beats « coffret
    // temps » when both are present, because it explains more of the catalogue
    // and is what a person would call the range.
    if (!found || products.length > found.products.length) {
      found = { name: phrase, products };
    }
  }
  if (!found) return null;

  // THE TOP CANDIDATES MUST BE INSIDE IT. A family that explains what scored
  // highest is the one the question is about; if something ranked well and is
  // NOT a member, the question reaches outside the family and answering about
  // the family alone would quietly drop it.
  const top = scored.slice(0, MIN_RANGE_MEMBERS);
  if (!top.every((c) => found.products.some((p) => p.id === c.product.id))) {
    return null;
  }

  // THE WHOLE FAMILY, NOT THE MEMBERS THAT SCORED. Somebody asking about a range
  // wants the range — « la gamme Temps Sublime » is twelve products on the live
  // catalogue, and returning the two that ranked highest would answer a narrower
  // question than the one asked.
  return { name: found.name, products: found.products };
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

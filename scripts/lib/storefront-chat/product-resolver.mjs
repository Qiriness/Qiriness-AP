/**
 * resolve_products — WHICH products the customer means, as stable ids.
 *
 * Not discovery. « quels sérums anti-âge avez-vous ? » is search_products'
 * job; this answers « la crème Source d'Eau Riche », « le sérum Temps Sublime »,
 * « les deux », « l'autre », « ça » on a product page. Deterministic and in
 * memory: no model, no database, about a millisecond.
 *
 * EVERY WORD OF VOCABULARY COMES FROM THE CATALOGUE. Nothing about a brand is
 * written here:
 *   - commercial name  the title's last segment (« … – Caresse Source d'Eau
 *                      Riche »), sizes stripped: what customers actually say;
 *   - care type        the title's head noun (« Crème », « Sérum », « Coffret »);
 *   - brand synonyms   the first word of a commercial name, mapped to the head
 *                      noun most of its products share (« Élixir » → Sérum);
 *   - identity words   words that live in commercial names far more than in
 *                      descriptions (« sublime », « source ») as opposed to
 *                      « anti », « hydratant »: a mention needs one, or it is
 *                      a description and is left to search unless it is a
 *                      clear single match.
 * The only hand-kept words are French (and a little English) grammar —
 * conjunctions, articles, « les deux », « l'autre » — in conversation-refs.mjs.
 *
 * NEVER A SILENT PICK. Several candidates come back as `ambiguous` with a
 * clarification the resolver builds from the data — the three products, or the
 * care types they span — and the widget shows it as chips.
 *
 * The scoring core is the support agent's matcher (product-matching.mjs:
 * normalise, tokenise, IDF), reused rather than copied.
 */

import { buildProductIndex, matchProduct, normalise, tokenise } from '../../../agent/src/retrieval/product-matching.mjs';
import {
  ANCHOR_WORDS,
  DEFINITE_WORDS,
  GRAMMAR_WORDS,
  INDEFINITE_WORDS,
  STOPWORD_LIKE,
  detectReference,
  isDiscoveryQuestion,
  splitMentions
} from './conversation-refs.mjs';

export const MAX_OPTIONS = 3;
/** A word is identity when at least this share of its title occurrences are in commercial names. */
const IDENTITY_SHARE = 0.5;
/** A brand synonym needs this share of its products to agree on one head noun. */
const SYNONYM_AGREEMENT = 0.75;
const SEGMENT_SPLIT = /\s+[-–—]\s*|\s*[-–—]\s+/;
const SIZE_TAIL = /\(\s*\d[^)]*\)|\b\d+\s?(ml|g|cl|patchs?)\b|\bx\s?\d+\b/gi;
const SKU_PATTERN = /\b[a-z]{1,2}\d{3}[a-z]{0,2}(?:-[a-z])?\b/gi;

/** Plural folding, the same on both sides: « crèmes » meets « crème », « patchs » meets « patch ». */
export function fold(token) {
  return token.length > 3 && /[sx]$/.test(token) ? token.slice(0, -1) : token;
}
const foldedTokens = (text) => tokenise(text).map(fold);

/** The title's commercial segment: its last dash-separated part, sizes removed. */
export function commercialName(title) {
  const segments = String(title)
    .split(SEGMENT_SPLIT)
    .map((s) => s.replace(SIZE_TAIL, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return segments.length ? segments[segments.length - 1] : String(title).trim();
}

/** First word of the title, as written and as a key. */
function headOf(title) {
  const written = String(title).trim().split(/\s+/)[0]?.replace(/[^\p{L}\p{N}]/gu, '') ?? '';
  return { label: written, key: fold(normalise(written)) };
}

/**
 * @param {import('./product-repository.mjs').Catalogue} catalogue
 * @param {{ aliases?: Map<string, string[]> }} [options]  curated alias → product ids (none yet)
 */
export function buildResolutionIndex(catalogue, { aliases = new Map() } = {}) {
  const products = catalogue.products.map((p) => {
    const segments = String(p.name).split(SEGMENT_SPLIT).filter((s) => s.trim());
    const commercial = commercialName(p.name);
    return {
      product: p,
      tokens: new Set(foldedTokens(p.name)),
      commercial,
      commercialKey: ` ${normalise(commercial)} `,
      commercialTokens: new Set(foldedTokens(commercial)),
      multiSegment: segments.length > 1,
      head: headOf(p.name)
    };
  });

  // Care types: head nouns shared by at least two products, labelled as most often written.
  const headCount = new Map();
  const headLabels = new Map();
  for (const e of products) {
    headCount.set(e.head.key, (headCount.get(e.head.key) ?? 0) + 1);
    const labels = headLabels.get(e.head.key) ?? new Map();
    labels.set(e.head.label, (labels.get(e.head.label) ?? 0) + 1);
    headLabels.set(e.head.key, labels);
  }
  const careTypes = new Map();
  for (const [key, count] of headCount) {
    if (count < 2 || !key) continue;
    const label = [...headLabels.get(key)].sort((a, b) => b[1] - a[1])[0][0];
    careTypes.set(key, label);
  }

  // Brand synonyms: the commercial name's first word → the head noun its products agree on.
  const prefixHeads = new Map();
  for (const e of products) {
    if (!e.multiSegment) continue;
    const first = foldedTokens(e.commercial)[0];
    if (!first || careTypes.has(first)) continue;
    const heads = prefixHeads.get(first) ?? [];
    heads.push(e.head.key);
    prefixHeads.set(first, heads);
  }
  const synonyms = new Map();
  for (const [prefix, heads] of prefixHeads) {
    if (heads.length < 2) continue;
    const tally = new Map();
    for (const h of heads) tally.set(h, (tally.get(h) ?? 0) + 1);
    const [topHead, n] = [...tally].sort((a, b) => b[1] - a[1])[0];
    if (careTypes.has(topHead) && n / heads.length >= SYNONYM_AGREEMENT) synonyms.set(prefix, topHead);
  }

  // Identity words: mostly found inside commercial names, and not a care word.
  const inTitles = new Map();
  const inCommercial = new Map();
  for (const e of products) {
    for (const t of e.tokens) inTitles.set(t, (inTitles.get(t) ?? 0) + 1);
    const comm = e.multiSegment ? e.commercialTokens : e.tokens;
    for (const t of comm) inCommercial.set(t, (inCommercial.get(t) ?? 0) + 1);
  }
  const identity = new Set();
  for (const [t, n] of inTitles) {
    if (careTypes.has(t) || synonyms.has(t) || /^\d+$/.test(t)) continue;
    if ((inCommercial.get(t) ?? 0) / n >= IDENTITY_SHARE) identity.add(t);
  }

  // A SKU can sit on several listings (a multi-size listing reuses the single
  // product's SKU): keep them all, and let the resolver prefer the listing where
  // that SKU stands alone.
  // Ranges the team curated as collections (axis `range`): their membership is
  // THE answer to « la gamme X »; title-derived ranges are only the fallback.
  const ranges = catalogue.collections
    .filter((c) => c.axis === 'range')
    .map((c) => ({
      name: c.title,
      tokens: new Set(foldedTokens(c.title)),
      ids: catalogue.products.filter((p) => p.collections.includes(c.handle)).map((p) => p.id)
    }))
    .filter((r) => r.tokens.size > 0 && r.ids.length > 0);

  const skus = new Map();
  for (const e of products) {
    for (const sku of e.product.skus ?? []) {
      const key = sku.toUpperCase();
      skus.set(key, [...(skus.get(key) ?? []), e.product.id]);
    }
  }

  return {
    products,
    byId: new Map(products.map((e) => [e.product.id, e])),
    careTypes,
    synonyms,
    identity,
    vocabulary: new Set(inTitles.keys()),
    skus,
    ranges,
    aliases,
    idf: buildProductIndex(catalogue.products.map((p) => ({ id: p.id, title: p.name, product_type: p.type })))
  };
}

/**
 * @param {string} message
 * @param {{
 *   index: ReturnType<typeof buildResolutionIndex>,
 *   pageProductId?: string | null,
 *   refs?: import('./conversation-refs.mjs').ConversationRefs,
 *   choice?: string | null
 * }} context
 */
export function resolveProducts(message, { index, pageProductId = null, refs = null, choice = null }) {
  const out = { products: [], candidates: [], unresolved: [], range: null, clarificationFor: null };
  const text = String(message ?? '');

  // 0. A chip the customer clicked: an id from the pending options, or a care type.
  if (choice && refs?.pending) {
    const chosen = resolveChoice(choice, refs.pending, index);
    if (chosen) return finish(chosen, index);
  }

  // 1. SKUs, exact.
  for (const match of text.matchAll(SKU_PATTERN)) {
    const sku = match[0].toUpperCase();
    const owners = index.skus.get(sku) ?? [];
    const alone = owners.filter((id) => index.byId.get(id)?.product.skus.length === 1);
    const pick = owners.length === 1 ? owners : alone.length === 1 ? alone : [];
    if (pick.length) out.products.push(resolved(index, pick[0], 'exact', `sku ${sku}`, match[0]));
    else if (owners.length > 1) out.candidates.push({ mention: match[0], entries: owners.map((id) => index.byId.get(id)), chunk: null });
  }

  // 2–4, 7. Explicit mentions, chunk by chunk, with type words carried across « le sérum et la crème X ».
  const chunks = splitMentions(text, normalise).map((chunk) => analyse(chunk, index));
  for (let i = 0; i < chunks.length; i += 1) {
    const c = chunks[i];
    // Borrow the line only when the chunk names none of its own (« le sérum »),
    // never when it names something the catalogue does not have (« la crème licorne »).
    if (c.identity.length === 0 && c.care.length > 0 && !c.unknownProduct) {
      const sibling = chunks[i + 1]?.identity.length ? chunks[i + 1] : chunks[i - 1]?.identity.length ? chunks[i - 1] : null;
      if (sibling) c.identity = [...sibling.identity];
    }
  }
  const discovery = isDiscoveryQuestion(normalise(text));
  for (const c of chunks) {
    // « des masques pour les mains », « une crème » : discovery. Only a product's
    // full commercial name still resolves inside it.
    if (c.indefinite) {
      if (c.identity.length > 0) resolveIdentityChunk(c, index, out, { exclusiveOnly: true });
      continue;
    }
    if (c.identity.length > 0) resolveIdentityChunk(c, index, out);
    else if (c.unknownProduct) out.unresolved.push(c.text.trim());
    else if (!discovery) resolveDescriptiveChunk(c, index, out);
  }

  // A follow-up to a clarification: « la crème » after « Crème, Sérum ou Coffret ? ».
  if (!out.products.length && !out.candidates.length && refs?.pending) {
    const chunk = analyse(normalise(text), index);
    if (chunk.care.length || chunk.literal.length) {
      const narrowed = narrow(refs.pending.ids.map((id) => index.byId.get(id)).filter(Boolean), chunk, index);
      if (narrowed.length === 1) out.products.push(resolved(index, narrowed[0].product.id, 'strong', `answer to the question: ${chunk.text}`, chunk.text));
      else if (narrowed.length > 1) out.candidates.push({ mention: refs.pending.mention, entries: narrowed, chunk });
    }
  }

  // 5–6. Conversation and page, only when nothing was named explicitly.
  if (!out.products.length && !out.candidates.length && !out.range) {
    const ref = detectReference(normalise(text), { refs, pageProductId, careWords: new Set([...index.careTypes.keys(), ...index.synonyms.keys()]) });
    if (ref?.ids?.length) {
      for (const id of ref.ids) if (index.byId.has(id)) out.products.push(resolved(index, id, 'strong', ref.reason, ref.cue));
      if (ref.shortfall) out.unresolved.push(ref.cue);
    } else if (ref?.ambiguousIds?.length) {
      out.candidates.push({ mention: ref.cue, entries: ref.ambiguousIds.map((id) => index.byId.get(id)).filter(Boolean), chunk: null });
    }
  }

  return finish(out, index);
}

/** Tokens of a chunk, typo-corrected against the catalogue's own words. */
function analyse(chunkText, index) {
  const raw = foldedTokens(chunkText);
  const corrections = [];
  const tokens = raw.map((t) => {
    if (index.vocabulary.has(t) || t.length < 4 || GRAMMAR_WORDS.has(t)) return t;
    const fixed = closest(t, index);
    if (fixed) corrections.push(`${t}→${fixed}`);
    return fixed ?? t;
  });
  const isCare = (t) => index.careTypes.has(t) || index.synonyms.has(t);

  // Every word with its predecessor, stopwords included: anchors and articles live there.
  const words = chunkText.split(' ').filter(Boolean).map((w) => fold(w));
  const anchored = (token) => {
    const at = words.indexOf(token);
    if (at < 0) return true;
    const before = words.slice(Math.max(0, at - 3), at);
    return before.some((w) => isCare(w));
  };
  let identity = [...new Set(tokens.filter((t) => index.identity.has(t)))];
  // A LONE NAME WORD NEEDS A CARE WORD BEFORE IT. « combien de temps », « sans
  // parfum », « la lune est belle »: a name word used as plain French — an
  // article is not enough. « le masque Lune » is a reference; two name words
  // (« la Lip Beauty ») need no anchor at all.
  if (identity.length === 1 && !anchored(identity[0])) identity = [];

  const careAt = words.findIndex((w) => isCare(w));
  const indefinite = careAt > 0 && INDEFINITE_WORDS.has(words[careAt - 1]);
  const definiteCare = careAt > 0 && DEFINITE_WORDS.has(words[careAt - 1]);
  const unknownWord = (w) => w && !index.vocabulary.has(w) && !GRAMMAR_WORDS.has(w) && !ANCHOR_WORDS.has(w) && !isCare(w) && !STOPWORD_LIKE.has(w);
  const corrected = new Map(raw.map((t, i) => [t, tokens[i]]));
  const after = words.slice(careAt + 1, careAt + 3).map((w) => corrected.get(w) ?? w);

  return {
    text: chunkText,
    tokens,
    corrections,
    identity,
    indefinite,
    // « la crème licorne magique »: a product named after a DEFINITE article in
    // two words the catalogue does not have. One unknown word is usually a verb
    // (« la crème convient »), so it takes two.
    unknownProduct: definiteCare && identity.length === 0 && after.length === 2 && after.every(unknownWord),
    care: [...new Set(tokens.filter(isCare))],
    literal: [...new Set(tokens.filter((t) => index.synonyms.has(t)))],
    rangeCue: /\b(gamme|ligne|collection|famille|toute|toutes|range|line)\b/.test(chunkText)
  };
}

function resolveIdentityChunk(chunk, index, out, { exclusiveOnly = false } = {}) {
  const mention = chunk.text.trim();
  // Exclusive commercial name contained in the chunk: exact.
  const padded = ` ${chunk.tokens.join(' ')} `;
  const exclusive = index.products
    .filter((e) => {
      const key = ` ${[...e.commercialTokens].join(' ')} `;
      return e.commercialTokens.size >= 2 && padded.includes(key) && !index.products.some((o) => o !== e && ` ${[...o.commercialTokens].join(' ')} `.includes(key));
    })
    .sort((a, b) => b.commercialTokens.size - a.commercialTokens.size);
  if (exclusive.length && !chunk.rangeCue) {
    out.products.push(resolved(index, exclusive[0].product.id, chunk.corrections.length ? 'strong' : 'exact', reasonFor('commercial name', chunk), mention));
    return;
  }
  if (exclusiveOnly) return;

  // « la gamme X »: a curated range collection first, the most specific that
  // the customer's words cover; the products sharing X's words only if none is.
  if (chunk.rangeCue) {
    const asked = new Set(chunk.tokens);
    const curated = index.ranges
      .filter((r) => [...r.tokens].every((t) => asked.has(t)))
      .sort((a, b) => b.tokens.size - a.tokens.size)[0];
    if (curated) {
      out.range = { name: curated.name, ids: curated.ids, source: 'collection' };
      return;
    }
  }

  const pool = index.products.filter((e) => chunk.identity.every((t) => e.tokens.has(t)));
  if (!pool.length) {
    out.unresolved.push(mention);
    return;
  }
  if (chunk.rangeCue && pool.length > 1) {
    out.range = { name: chunk.identity.join(' '), ids: pool.map((e) => e.product.id), source: 'titles' };
    return;
  }
  const narrowed = narrow(pool, chunk, index);
  if (narrowed.length === 1) {
    out.products.push(resolved(index, narrowed[0].product.id, 'strong', reasonFor(chunk.care.length ? `name + type ${chunk.care.join(', ')}` : 'name', chunk), mention));
  } else {
    out.candidates.push({ mention, entries: narrowed, chunk });
  }
}

/** No identity word: resolve only a clear, single descriptive match (« le démaquillant yeux biphasé »). */
function resolveDescriptiveChunk(chunk, index, out) {
  if (chunk.tokens.length < 2) return;
  const r = matchProduct(chunk.tokens.join(' '), index.idf, { limit: 6 });
  if (r.match) {
    out.products.push(resolved(index, r.match.id, 'strong', reasonFor('description', chunk), chunk.text.trim()));
  } else if (r.range) {
    out.range = { name: r.range.name, ids: r.range.products.map((p) => p.id) };
  }
}

/**
 * Narrow candidates with the words the customer used: a brand synonym literally
 * in the title first (« élixir »), then the care type (« sérum » ≈ Élixir), then
 * every other word that is in some candidates and not others (« nuit », « riche »).
 * A filter that would leave nothing is ignored — « le soin X » is not a type.
 */
function narrow(pool, chunk, index) {
  let current = pool;
  const keep = (filter) => {
    const next = current.filter(filter);
    if (next.length) current = next;
  };
  if (chunk.literal.length) keep((e) => chunk.literal.some((t) => e.tokens.has(t)));
  if (chunk.care.length) {
    const heads = new Set(chunk.care.map((t) => index.synonyms.get(t) ?? t));
    keep((e) => heads.has(e.head.key));
  }
  for (const t of chunk.tokens) {
    if (chunk.identity.includes(t) || chunk.care.includes(t)) continue;
    if (current.some((e) => e.tokens.has(t)) && !current.every((e) => e.tokens.has(t))) keep((e) => e.tokens.has(t));
  }
  return rank(current, chunk, index);
}

function rank(entries, chunk, index) {
  const asked = new Set(chunk?.tokens ?? []);
  const weight = (t) => index.idf.idf.get(t) ?? 1;
  const score = (e) => {
    let hit = 0;
    let total = 0;
    for (const t of e.tokens) {
      total += weight(t);
      if (asked.has(t)) hit += weight(t);
    }
    return total ? hit / total : 0;
  };
  return [...entries].sort(
    (a, b) => score(b) - score(a) || Number(b.product.inStock) - Number(a.product.inStock) || a.product.name.length - b.product.name.length
  );
}

function resolveChoice(choice, pending, index) {
  const out = { products: [], candidates: [], unresolved: [], range: null };
  if (pending.ids.includes(choice) && index.byId.has(choice)) {
    out.products.push(resolved(index, choice, 'exact', 'customer chose it', pending.mention));
    return out;
  }
  const key = fold(normalise(choice));
  if (index.careTypes.has(key)) {
    const entries = pending.ids.map((id) => index.byId.get(id)).filter((e) => e && e.head.key === key);
    if (entries.length === 1) out.products.push(resolved(index, entries[0].product.id, 'strong', `customer chose ${index.careTypes.get(key)}`, pending.mention));
    else if (entries.length > 1) out.candidates.push({ mention: pending.mention, entries, chunk: null });
    return out.products.length || out.candidates.length ? out : null;
  }
  return null;
}

function resolved(index, id, strength, reason, mention) {
  const e = index.byId.get(id);
  return { id, handle: e.product.handle, name: e.product.name, match_strength: strength, match_reason: reason, mention };
}

function reasonFor(what, chunk) {
  return chunk.corrections.length ? `${what}, corrected spelling: ${chunk.corrections.join(', ')}` : what;
}

/** The contract: status, products, candidates (top 3 each), one clarification, unresolved mentions, range. */
function finish(out, index) {
  const products = [...out.products];
  const ambiguous = [];
  for (const c of out.candidates) {
    if (c.entries.length === 1) products.push(resolved(index, c.entries[0].product.id, 'strong', 'only candidate', c.mention));
    else if (c.entries.length > 1) ambiguous.push(c);
  }
  const unique = dedupe(products);
  const candidates = ambiguous.map((c) => ({
    mention: c.mention,
    options: c.entries.slice(0, MAX_OPTIONS).map((e) => ({
      id: e.product.id,
      handle: e.product.handle,
      name: e.product.name,
      care_type: index.careTypes.get(e.head.key) ?? null
    })),
    all: c.entries,
    identity: c.chunk?.identity ?? []
  }));
  const unresolved = [...new Set(out.unresolved)];
  const settled = unique.length > 0 || Boolean(out.range);

  let status;
  if (!settled && !candidates.length) status = 'unresolved';
  else if (settled && !candidates.length && !unresolved.length) status = 'resolved';
  else if (!settled && !unresolved.length) status = 'ambiguous';
  else status = 'partial';

  const first = candidates[0] ?? null;
  return {
    status,
    products: unique,
    candidates: candidates.map(({ mention, options }) => ({ mention, options })),
    clarification: first ? clarify(first, index) : null,
    unresolved_mentions: unresolved,
    range: out.range,
    // For the conversation memory: what a follow-up « la crème » or a chip narrows.
    pending: first ? { mention: first.mention, ids: first.all.map((e) => e.product.id) } : null
  };
}

/** Three products when they are few or share a type; otherwise the care types they span. */
function clarify(candidate, index) {
  const all = candidate.all;
  const types = new Map();
  for (const e of all) {
    const label = index.careTypes.get(e.head.key);
    if (label) types.set(label, (types.get(label) ?? 0) + 1);
  }
  if (all.length > MAX_OPTIONS && types.size > 1) {
    return {
      mention: candidate.mention,
      kind: 'choose_care_type',
      options: [...types].sort((a, b) => b[1] - a[1]).slice(0, MAX_OPTIONS).map(([label]) => ({ label }))
    };
  }
  return {
    mention: candidate.mention,
    kind: 'choose_product',
    options: candidate.options.map((o) => ({ label: shortLabel(index.byId.get(o.id), index, candidate.identity), id: o.id }))
  };
}

/** The commercial name when it names this product alone, else the full title. */
function shortLabel(entry, index, required = []) {
  const keeps = (label) => {
    const words = new Set(foldedTokens(label));
    return required.every((t) => words.has(t));
  };
  // 1. The commercial name, when it names this product alone and keeps the customer's words.
  const key = ` ${[...entry.commercialTokens].join(' ')} `;
  const unique = entry.commercialTokens.size >= 2 && !index.products.some((o) => o !== entry && ` ${[...o.commercialTokens].join(' ')} `.includes(key));
  if (unique && keeps(entry.commercial)) return entry.commercial;
  // 2. Care type + the title's last segment, size included: « Crème Source d'Eau 50 ml ».
  const segments = String(entry.product.name).split(SEGMENT_SPLIT).map((x) => x.trim()).filter(Boolean);
  const typed = segments.length > 1 ? `${entry.head.label} ${segments[segments.length - 1]}` : entry.product.name;
  if (keeps(typed) && typed.length < entry.product.name.length) return typed;
  // 3. The full title.
  return entry.product.name;
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((p) => (seen.has(p.id) ? false : seen.add(p.id)));
}

/** Closest catalogue word within 1 edit (2 for long words); identity words win a tie; null if still tied. */
function closest(token, index) {
  const limit = token.length >= 8 ? 2 : 1;
  let bestDistance = limit + 1;
  let best = [];
  for (const word of index.vocabulary) {
    if (Math.abs(word.length - token.length) > limit) continue;
    // People drop, swap or double letters; they rarely add a stray one. A word
    // shorter than what was typed is accepted only when the extra letter is a
    // doubled one (« zenn »): otherwise « matin » would become « main ».
    if (word.length < token.length && !isDoubledLetter(token, word)) continue;
    const d = editDistance(token, word, limit);
    if (d < bestDistance) {
      bestDistance = d;
      best = [word];
    } else if (d === bestDistance) {
      best.push(word);
    }
  }
  if (bestDistance > limit || !best.length) return null;
  const preferred = best.filter((w) => index.identity.has(w));
  const pick = preferred.length ? preferred : best;
  return pick.length === 1 ? pick[0] : null;
}

function isDoubledLetter(typed, word) {
  for (let i = 1; i < typed.length; i += 1) {
    if (typed[i] === typed[i - 1] && typed.slice(0, i) + typed.slice(i + 1) === word) return true;
  }
  return false;
}

/** Damerau–Levenshtein (adjacent transpositions), cut off past `limit`. */
export function editDistance(a, b, limit = Infinity) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i < rows; i += 1) {
    let rowMin = Infinity;
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > limit) return limit + 1;
  }
  return d[a.length][b.length];
}

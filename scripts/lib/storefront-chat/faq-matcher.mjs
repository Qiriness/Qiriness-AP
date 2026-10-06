import { normalise, nearWord } from './knowledge-topics.mjs';

const STOPWORDS = new Set(('a au aux avec ce cet cette ces ca de des du en et est il elle ils elles je le la les leur ma mes mon ne nous on ou par pas pour puis puisje peux peut quel quelle quels quelles que qui se ses si son sont sur un une vous votre vos comment combien dois do doisje the a an is are can i my to of how what it this for and does faut faire produit produits soin soins').split(' '));
export function keywords(value) {
  return [...new Set(normalise(value).split(' ').filter((w) => w.length > 2 && !STOPWORDS.has(w)))];
}

const LIMIT = 3;
const MAX_ANSWER_CHARS = 1800;

/** Build small runtime records without changing article/chunk storage. */
export function faqRecords(documents = []) {
  const out = [];
  for (const d of documents) {
    if (d.approval_status !== 'approved' || d.deleted_at || d.core_topic || d.category === 'brand_story') continue;
    const productIds = Array.isArray(d.product_ids) ? d.product_ids.filter((id) => typeof id === 'string') : [];
    // Unlinked product articles must not silently become general guidance.
    if (!productIds.length && ['product', 'product_stock', 'cosmetovigilance'].includes(d.category)) continue;
    for (const [i, section] of (Array.isArray(d.sections) ? d.sections : []).entries()) {
      if (typeof section.heading !== 'string' || !section.heading.trim() || typeof section.text !== 'string') continue;
      const lines = section.text.trim().split(/\n+/).map((l) => l.trim()).filter(Boolean);
      const aliases = [];
      // Only unmistakable leading questions are aliases. Keep other prose intact.
      while (lines.length > 1 && lines[0].endsWith('?')) aliases.push(lines.shift());
      const answer = lines.join('\n');
      if (!answer || answer.length > MAX_ANSWER_CHARS) continue; // Never cut conditions mid-answer.
      out.push({
        id: `${d.id}:${section.anchor || section.order || i}`,
        document_id: d.id,
        topic: d.category ?? 'faq',
        canonical_question: section.heading.trim(),
        answer,
        aliases,
        keywords: keywords([section.heading, ...aliases].join(' ')),
        locale: d.locale ?? 'fr',
        active: true,
        updated_at: d.updated_at ?? null,
        product_ids: productIds
      });
    }
  }
  return out;
}

/** Exact -> alias/keywords -> topic-narrowed lexical -> fuzzy. No network. */
export function matchFaqs(records, { query, topic = null, locale = 'fr', limit = LIMIT } = {}) {
  if (typeof query !== 'string' || !query.trim() || query.length > 1000) return { status: 'invalid_arguments', matches: [] };
  if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 5)) return { status: 'invalid_arguments', matches: [] };
  const text = normalise(query);
  const wantedLocale = String(locale || 'fr').split('-')[0].toLowerCase();
  const active = records.filter((r) => r.active !== false && (!topic || r.topic === topic));
  const local = active.filter((r) => r.locale.split('-')[0] === wantedLocale);
  const pool = local.length ? local : active.filter((r) => r.locale === 'fr');
  const canonical = pool.filter((r) => normalise(r.canonical_question) === text);
  if (canonical.length) return finish(canonical.map((r) => ({ r, score: 1 })), 'exact', limit);
  const alias = pool.filter((r) => r.aliases.some((a) => normalise(a) === text));
  if (alias.length) return finish(alias.map((r) => ({ r, score: 1 })), 'alias', limit);
  const terms = keywords(query);
  if (!terms.length) return { status: 'not_found', matches: [] };
  const ranked = (fuzzy) => pool.map((r) => {
    const matched = terms.filter((t) => r.keywords.some((k) => fuzzy ? nearWord(t, k) : t === k));
    const coverage = matched.length / terms.length;
    const specificity = matched.length / Math.max(r.keywords.length, 1);
    const score = coverage * 0.8 + specificity * 0.2;
    // One generic shared word ("temps", "commande") is not evidence of intent.
    const discriminative = matched.length === 1 && pool.filter((other) => other.keywords.includes(matched[0])).length === 1;
    return { r, score, accept: coverage >= 0.6 && (matched.length >= 2 || (terms.length === 1 && discriminative)) };
  }).filter((x) => x.accept).sort((a, b) => b.score - a.score || a.r.id.localeCompare(b.r.id));
  const lexical = ranked(false);
  if (lexical.length) return finish(lexical, topic ? 'topic' : 'keywords', limit);
  const fuzzy = ranked(true);
  return fuzzy.length ? finish(fuzzy, 'fuzzy', limit) : { status: 'not_found', matches: [] };
}

function finish(ranked, stage, limit) {
  if (ranked.length > 1 && ranked[0].score - ranked[1].score < 0.1) {
    return { status: 'ambiguous', matches: [], candidates: ranked.slice(0, limit ?? LIMIT).map(({ r }) => ({ id: r.id, canonical_question: r.canonical_question })), match_stage: stage };
  }
  // Return only the winning intent; unrelated runners-up are not extra answers.
  const { r } = ranked[0];
  const { product_ids, keywords: words, active, ...match } = r;
  return { status: 'found', matches: [{ ...match, match_stage: stage }] };
}

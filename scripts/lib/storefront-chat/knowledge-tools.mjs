import { PARAMETERS, days, amount, text, fillParameters, placeholdersIn } from '../parameters.mjs';
import { matchFaqs, keywords } from './faq-matcher.mjs';
import { KNOWLEDGE_TTL_MS } from './knowledge-repository.mjs';
import { POLICY_TOPICS, POLICY_KEYS, ownPolicies, policyTopics, deliveryKeys, validCountry, countriesIn, normalise, productTopic } from './knowledge-topics.mjs';

export const KNOWLEDGE_TOOL_NAMES = ['get_policy', 'search_faqs', 'get_product_policy'];
const PARAMETER_FIELDS = {
  dispatch_days: { field: 'dispatch_time', unit: 'working_days', starts_at: 'payment_received' },
  france_delivery_days: { field: 'delivery_time', unit: 'working_days', starts_at: 'dispatch', scope: 'FR' },
  abroad_delivery_days: { field: 'delivery_time', unit: 'working_days', starts_at: 'dispatch', scope: 'non_FR' },
  free_shipping_threshold: { field: 'free_shipping_threshold', unit: 'shop_currency', scope: 'FR' },
  returns_window_days: { field: 'return_window', unit: 'days', starts_at: 'delivery' },
  withdrawal_days: { field: 'withdrawal_window', unit: 'days' },
  refund_processing_days: { field: 'refund_processing_time', unit: 'working_days', starts_at: 'refund_issued' },
  returns_address: { field: 'returns_address' }
};

const nullableString = { type: ['string', 'null'] };
const definition = (name, description, properties) => ({ type: 'function', function: {
  name, description, strict: true,
  parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }
} });
export function knowledgeToolDefinitions(knowledge = null) {
  // Matching is lexical: an English question finds nothing in French FAQs. The
  // FAQs' own languages, from the data, tell the model what to search in.
  const faqLanguages = [...new Set((knowledge?.faqs ?? []).map((r) => String(r.locale || '').slice(0, 2)).filter(Boolean))];
  const queryLanguage = faqLanguages.length ? ` FAQ entries are written in ${faqLanguages.join(', ')}: write query in ${faqLanguages.length > 1 ? 'one of those languages' : 'that language'}, translating the customer's words when they wrote in another.` : '';
  const own = ownPolicies(knowledge);
  const ownTopics = own.length ? ` The brand's own policies are topics too, by key: ${own.map((p) => `${p.policy_key} (${p.name}${p.purpose ? `: ${p.purpose}` : ''})`).join('; ')}. A question one of them covers: fetch it and answer from it.` : '';
  return [
    definition('get_policy', 'Authoritative general shop policy and referenced parameter facts. Preserve all conditions and possibilities. A delivery time does not establish that a country is served; a threshold does not establish a current offer. Missing facts cannot be inferred.' + ownTopics, {
      topic: { type: 'string', enum: [...POLICY_TOPICS, ...own.map((p) => p.policy_key)] },
      country: { ...nullableString, description: 'ISO country code if the customer supplied a destination, otherwise null. Never derive it from language.' },
      context: { type: ['object', 'null'], properties: { query: nullableString }, required: ['query'], additionalProperties: false }
    }),
    definition('search_faqs', 'Find a GENERAL approved FAQ by exact question, aliases, keywords, topic and fuzzy lexical matching. Product-specific guidance is excluded. A policy_reference requires get_policy; the FAQ is intent, not a copy of changing facts.' + queryLanguage, {
      query: { type: 'string' }, topic: nullableString, limit: { type: ['integer', 'null'], description: '1 to 5, default 3. Ambiguous matches contain questions only.' }
    }),
    definition('get_product_policy', 'SECOND PATH ONLY: approved guidance linked to a product already resolved in this turn. Read its catalogue facts and relevant Shopify FAQs first. Use only when those facts are insufficient or the question needs controlled precautions/restrictions. Never browse other products.', {
      product_id: { type: 'string' }, topic: { ...nullableString, enum: ['usage', 'precautions', 'suitability', 'warranty', 'returns', 'claims', null] }, query: nullableString
    })
  ];
}

function fresh(knowledge, now) {
  return knowledge && now - knowledge.loadedAt < KNOWLEDGE_TTL_MS;
}

/** Paragraphs stay whole, including lists and qualifiers. Never clip an instruction. */
function relevantPassages(content, query) {
  const paragraphs = String(content).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const terms = keywords(query);
  const ranked = paragraphs.map((value, index) => ({ value, index, score: keywords(value).filter((w) => terms.includes(w)).length }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = new Set([0, 1]); // Opening applicability and conditions travel together.
  // Never discard a restriction just because the customer used "ouverte"
  // while the author wrote "non utilisé".
  paragraphs.forEach((passage, i) => {
    if (/\b(sauf|exception\w*|non utilise|non eligible)\b|\bne\b[^\n.!?]{0,120}\bpas\b/.test(normalise(passage))) selected.add(i);
  });
  ranked.filter((p) => !terms.length || p.score > 0).slice(0, 3).forEach((p) => selected.add(p.index));
  const passages = paragraphs.filter((p, i) => selected.has(i) && p.length <= 1800);
  return { passages, incomplete: paragraphs.some((p, i) => selected.has(i) && p.length > 1800) };
}

/**
 * A policy of the brand's own goes whole while it fits: its headings stand as paragraphs of their
 * own (a range's name, then its text), and a comparison of ranges needs every one.
 */
function wholePolicy(content) {
  const paragraphs = String(content).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return paragraphs.join('').length <= 6000 ? { passages: paragraphs, incomplete: false } : null;
}

function supportedDestination(policy, country) {
  if (!country || !policy) return 'unknown';
  // Only an explicit enumerated destination list is parsed. Other prose stays prose.
  const list = String(policy.content).match(/destinations suivantes\s*:\s*([\s\S]+?)(?:\n\s*\n\s*Si\b|$)/i)?.[1];
  if (!list) return 'unknown';
  const countries = countriesIn(list);
  return countries.length ? countries.includes(country) ? 'supported' : 'unsupported' : 'unknown';
}

export function getPolicy(knowledge, { topic, country = null, context = null } = {}, { query = '', currency = 'EUR', now = Date.now() } = {}) {
  const own = ownPolicies(knowledge).some((p) => p.policy_key === topic);
  if (!(POLICY_TOPICS.includes(topic) || own) || (country !== null && !validCountry(country)) || (context !== null && (typeof context !== 'object' || Array.isArray(context))) || (context?.query !== undefined && context.query !== null && typeof context.query !== 'string')) return { status: 'invalid_arguments' };
  if (!fresh(knowledge, now)) return { status: 'unavailable', topic, reason: 'knowledge_unavailable_or_expired' };
  query = context?.query ?? query;
  if (query.length > 1000) return { status: 'invalid_arguments' };
  const keys = own ? [topic] : topic === 'delivery' ? deliveryKeys(query) : [...POLICY_KEYS[topic]];
  if (topic === 'delivery' && country && !keys.includes('delivery_location_policy')) keys.push('delivery_location_policy');
  const candidates = keys.map((key) => knowledge.policies.find((p) => p.active && p.policy_key === key)).filter(Boolean);
  const missing = keys.filter((key) => !candidates.some((p) => p.policy_key === key));
  const sources = [];
  const parameters = [];
  const facts = {};
  let returnedChars = 0;
  const location = candidates.find((p) => p.policy_key === 'delivery_location_policy');
  const countrySupport = supportedDestination(location, country);
  for (const policy of candidates) {
    const quoted = placeholdersIn(policy.content);
    const invalid = quoted.filter((key) => {
      const kind = PARAMETERS[key]?.kind;
      return kind === 'days' ? days(knowledge.parameters, key) === null : kind === 'amount' ? amount(knowledge.parameters, key) === null : kind === 'text' ? text(knowledge.parameters, key) === null : true;
    });
    const rendered = fillParameters(policy.content, knowledge.parameters);
    if (invalid.length || !rendered.resolved) {
      missing.push(...invalid.map((key) => `parameter:${key}`));
      continue;
    }
    const selected = own ? wholePolicy(rendered.text) ?? relevantPassages(rendered.text, query) : relevantPassages(rendered.text, query);
    if (selected.incomplete || !selected.passages.length) { missing.push(`unbounded_passage:${policy.policy_key}`); continue; }
    const chars = selected.passages.reduce((total, passage) => total + passage.length, 0);
    if (returnedChars + chars > 6000) { missing.push(`response_limit:${policy.policy_key}`); continue; }
    returnedChars += chars;
    sources.push({ policy_key: policy.policy_key, version: policy.version, updated_at: policy.updated_at ?? null, passages: selected.passages });
    for (const key of quoted) {
      const field = PARAMETER_FIELDS[key];
      if (!field) continue; // Internal operational parameters never become public facts.
      const kind = PARAMETERS[key].kind;
      const value = kind === 'days' ? days(knowledge.parameters, key) : kind === 'amount' ? amount(knowledge.parameters, key) : text(knowledge.parameters, key);
      const fact = { parameter_key: key, value, kind, ...field, updated_at: knowledge.parameterDates.get(key) ?? null, policy_key: policy.policy_key, ...(field.unit === 'shop_currency' ? { currency } : {}) };
      parameters.push(fact);
      // A parameter is never an unconditional policy. The passages define applicability.
      if (field.scope && (!country || (field.scope === 'FR' ? country !== 'FR' : country === 'FR'))) continue;
      if (field.field === 'delivery_time' && countrySupport !== 'supported') continue;
      facts[field.field] = fact;
    }
  }
  return {
    status: sources.length ? missing.length ? 'partial' : 'found' : 'not_found', topic, country,
    ...(topic === 'delivery' ? { country_support: countrySupport } : {}),
    facts, parameters, sources, missing,
    instruction: 'Facts apply only under their source passages. Preserve may/typically/occasionally and exceptions. No order, current promotion or individual eligibility is verified. Unknown applicability requires clarification or customer service.'
  };
}

const FAQ_TOPIC_MAP = { delivery: 'delivery', returns: 'return_exchange', refunds: 'return_exchange', payments: 'payment', promotions: 'promotions', privacy: 'legal_privacy', cancellations: 'order', order_changes: 'order' };
export function searchFaqs(knowledge, args = {}, { locale = 'fr', now = Date.now() } = {}) {
  if (!fresh(knowledge, now)) return { status: 'unavailable', matches: [] };
  const topic = FAQ_TOPIC_MAP[args.topic] ?? args.topic ?? null;
  // General FAQ sections can contain any subject; map their intent without storage edits.
  const records = knowledge.faqs.map((r) => {
    const topics = policyTopics(r.canonical_question);
    const inferred = topics[0];
    const account = /\b(compte|identifiant|account|password|donnees personnelles)\b/.test(normalise(r.canonical_question));
    return { ...r, topic: inferred ? FAQ_TOPIC_MAP[inferred] ?? r.topic : account ? 'account' : r.topic };
  });
  const result = matchFaqs(records, { ...args, topic, locale, limit: args.limit ?? 3 });
  if (result.status !== 'found') return result;
  return { ...result, matches: result.matches.map((match) => {
    const topics = policyTopics(match.canonical_question);
    if (!topics.length) return match;
    const { answer, ...intent } = match;
    return { ...intent, policy_reference: topics.map((topic) => ({ topic, context: { query: match.canonical_question } })) };
  }) };
}

/** Only clearly explicit usage evidence can short-circuit a guidance lookup. */
export function explicitProductEvidence(product, query) {
  const q = normalise(query);
  const usage = normalise(product?.usage);
  if (/\b(matin|morning)\b/.test(q) && /\b(soir|evening|night)\b/.test(q) && /\b(matin|morning)\b/.test(usage) && /\b(soir|evening|night)\b/.test(usage)) return { how_to_use: product.usage };
  const matched = matchFaqs(product?.faqs ?? [], { query, limit: 1 });
  return matched.status === 'found' ? { faq_answers: matched.matches } : null;
}

/**
 * A PRODUCT'S OWN FAQ, WHEN NO SINGLE QUESTION MATCHES. The matcher compares
 * keywords with the FAQ questions only, so « comment utiliser le masque LED
 * avec la télécommande ? » matched none of the mask's 12 questions although
 * three answers explain the remote (2026-10-07). A product's FAQ is small and
 * already scoped to the product the customer named, so its entries are
 * returned ranked by how many query words they share (question and answer),
 * within a fixed size, and the model answers from the relevant ones.
 */
const DIGEST_MAX_CHARS = 6000;
function productFaqDigest(records, query, topic = null) {
  const terms = keywords(query);
  const plain = (s) => keywords(s).join(' ');
  const onTopic = (r) => Boolean(topic) && productTopic(`${r.canonical_question} ${r.aliases.join(' ')}`) === topic;
  const scored = records.map((r) => {
    const text = ` ${plain(`${r.canonical_question} ${r.answer}`)} `;
    return { r, hits: terms.filter((t) => text.includes(` ${t} `) || text.includes(` ${t}`)).length, topic: onTopic(r) ? 1 : 0 };
  }).sort((a, b) => b.hits - a.hits || b.topic - a.topic);
  // No entry shares a word: the question is in another language than the FAQ
  // (« warranty » / « garantie »). Every entry then goes, on-topic first, for
  // the model to read; otherwise the ones sharing words.
  const shared = scored.some((s) => s.hits);
  const entries = [];
  let size = 0;
  for (const { r, hits } of scored) {
    if (shared && !hits && entries.length) break;
    const length = r.canonical_question.length + String(r.answer).length;
    if (size + length > DIGEST_MAX_CHARS && entries.length) break;
    size += length;
    entries.push({ id: r.id, canonical_question: r.canonical_question, answer: r.answer, shared_words: hits });
  }
  return { status: 'found', match_stage: 'product_faq_digest', note: 'No single FAQ question matched: these are this product’s FAQ entries, most relevant first. Answer only from the entries that address the question; if none does, say so.', matches: entries };
}

export async function runKnowledgeTool(name, args, knowledge, { resolvedIds = new Set(), productDataIds = new Set(), catalogue = null, readProductPolicies = null, query = '', country = null, locale = 'fr', currency = 'EUR', now = Date.now() } = {}) {
  try {
    if (name === 'get_policy') {
      if (args?.country !== undefined && args.country !== null && !validCountry(args.country)) return { status: 'invalid_arguments' };
      const mentioned = countriesIn(query);
      // Explicit wording overrides both passive context and model arguments.
      const destination = mentioned.length ? mentioned.length === 1 ? mentioned[0] : null : country ?? null;
      return getPolicy(knowledge, { ...args, country: destination }, { query, currency, now });
    }
    if (name === 'search_faqs') return searchFaqs(knowledge, args, { locale, now });
    if (name !== 'get_product_policy') return { status: 'invalid_arguments' };
    const id = args?.product_id;
    if (!resolvedIds.has(id)) return { status: 'forbidden', reason: 'resolve_product_first' };
    const product = catalogue?.products.find((p) => p.id === id);
    if (!product) return { status: 'not_found' };
    if (!productDataIds.has(id)) return { status: 'product_data_required', product_id: id, instruction: 'Read get_product first.' };
    if (args.topic !== undefined && args.topic !== null && !['usage', 'precautions', 'suitability', 'warranty', 'returns', 'claims'].includes(args.topic)) return { status: 'invalid_arguments' };
    if (args.query !== undefined && args.query !== null && typeof args.query !== 'string') return { status: 'invalid_arguments' };
    const asked = args.query ?? query;
    if (!asked.trim() || asked.length > 1000) return { status: 'invalid_arguments' };
    const evidence = explicitProductEvidence(product, asked);
    if (evidence) return { status: 'use_product_data', product_id: id, evidence };
    // THE PRODUCT'S SHOPIFY FAQ JOINS THE DIGEST (dev store, 2026-10-29). It
    // only had the single-question matcher above, so « combien de fois par
    // semaine » on the Regard d'Or patches missed « À quelle fréquence utiliser
    // les patchs yeux ? » and the reply said the frequency was not given.
    const shopifyFaqs = product.faqs ?? [];
    if (!readProductPolicies && !shopifyFaqs.length) return { status: 'unavailable', product_id: id };
    const approved = readProductPolicies ? (await readProductPolicies(id)).filter((r) => r.product_ids.includes(id)) : [];
    const records = [...shopifyFaqs, ...approved];
    const topic = args.topic ?? productTopic(asked);
    const pool = topic ? records.filter((r) => productTopic(`${r.canonical_question} ${r.aliases.join(' ')}`) === topic) : records;
    const productWords = new Set(keywords(product.name));
    const reducedQuery = keywords(asked).filter((w) => !productWords.has(w)).join(' ') || asked;
    const exact = matchFaqs(pool, { query: asked, locale, limit: 3 });
    const matched = exact.status !== 'not_found' ? exact : matchFaqs(pool, { query: reducedQuery, locale, limit: 3 });
    if (matched.status !== 'not_found' || !records.length) return { product_id: id, ...matched };
    return { product_id: id, ...productFaqDigest(records, reducedQuery, topic) };
  } catch {
    // Do not put transport errors, credentials or unrestricted rows into the model.
    return { status: 'unavailable', reason: 'source_read_failed' };
  }
}

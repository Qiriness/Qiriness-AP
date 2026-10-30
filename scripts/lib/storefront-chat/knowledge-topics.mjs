// Storefront-only routing vocabulary and explicit bindings to existing keys.
// These are source identifiers, never copies of policy facts or parameter values.
import { SUPPORTED, packs, wordsAt } from '../i18n/languages.mjs';

export const POLICY_KEYS = {
  delivery: ['delivery_time_policy', 'dispatch_time_policy', 'shipping_cost_policy', 'delivery_location_policy'],
  returns: ['return_policy'],
  refunds: ['refund_policy'],
  payments: ['payment_policy'],
  cancellations: ['order_cancellation_policy'],
  promotions: ['promotion_discount_policy'],
  privacy: [], // No authoritative company policy exists for this topic yet.
  order_changes: ['address_change_policy', 'order_modification_policy']
};
export const POLICY_TOPICS = Object.keys(POLICY_KEYS);
const BOUND_KEYS = new Set(Object.values(POLICY_KEYS).flat());

/**
 * The brand's own policies: every one the chat reads (active, switched on for the storefront in the
 * dashboard) that no topic above names (owner, 2026-10-20: a policy on the ranges, « Gamme
 * Qiriness »). Each is its own get_policy topic, by its key; its purpose, written in the dashboard,
 * tells the model when to fetch it. A new policy needs no code.
 */
export function ownPolicies(knowledge) {
  return (knowledge?.policies ?? []).filter((p) => p.active && !BOUND_KEYS.has(p.policy_key) && String(p.content ?? '').trim());
}

// Every language the chat speaks (i18n/<code>/words.mjs, `topics`): a topic missing in one of them
// is a bug (knowledge.test.mjs runs every case in each).
const VOCABULARY = Object.fromEntries([...POLICY_TOPICS].map((topic) => [topic, wordsAt(`topics.${topic}`)]));

// The cues below settle a topic or a policy key (`topicCues`): one whole-word pattern per cue.
const cue = (key) => new RegExp(`\\b(${wordsAt(`topicCues.${key}`).join('|')})\\b`);
const CUE = Object.fromEntries(['personalData', 'privacyChange', 'change', 'orderOrAddress', 'gift', 'giftOffer', 'address', 'timeOrCost', 'shippingCost', 'shippingWhere',
  'dispatch', 'deliveryTime', 'deliveryTimeStrict', 'deliveryWord', 'precautions', 'warranty', 'claims', 'returns', 'usage', 'abroad'].map((key) => [key, cue(key)]));
// « allerg » → « allergique », « allergies »: a prefix, the rest of the word allowed.
const SUITABILITY = new RegExp(`\\b(${wordsAt('topicCues.suitability').join('|')})\\w*`);
const COUNTRY_LEAD = new RegExp(`^(?:(?:${wordsAt('topicCues.countryLead').join('|')})\\s+)+`);

export function normalise(value) {
  return String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** One insertion/deletion/substitution or adjacent transposition. Never grammar correction. */
export function nearWord(a, b) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const differing = [...a].flatMap((c, i) => c === b[i] ? [] : [i]);
    return differing.length === 1 || (differing.length === 2 && differing[1] === differing[0] + 1 && a[differing[0]] === b[differing[1]] && a[differing[1]] === b[differing[0]]);
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  for (let i = 0; i < long.length; i += 1) if (long.slice(0, i) + long.slice(i + 1) === short) return true;
  return false;
}

export function policyTopics(query) {
  const text = normalise(query);
  const words = text.split(' ');
  const found = Object.entries(VOCABULARY).filter(([, terms]) => words.some((w) => terms.some((t) => nearWord(w, t)))).map(([topic]) => topic);
  if (CUE.personalData.test(text) && !CUE.privacyChange.test(text)) found.push('privacy');
  if (CUE.change.test(text) && CUE.orderOrAddress.test(text)) found.push('order_changes');
  if (CUE.gift.test(text) && CUE.giftOffer.test(text)) found.push('promotions');
  if (found.includes('order_changes') && CUE.address.test(text) && !CUE.timeOrCost.test(text)) return [...new Set(found.filter((t) => t !== 'delivery'))];
  return [...new Set(found)];
}

export function deliveryKeys(query) {
  const text = normalise(query);
  const keys = [];
  if (CUE.shippingCost.test(text)) keys.push('shipping_cost_policy');
  if (CUE.shippingWhere.test(text)) keys.push('delivery_location_policy');
  if (CUE.dispatch.test(text)) keys.push('dispatch_time_policy');
  if (CUE.deliveryTime.test(text) && (!keys.length || CUE.deliveryTimeStrict.test(text)) && (!keys.includes('dispatch_time_policy') || CUE.deliveryWord.test(text))) keys.push('delivery_time_policy');
  return keys.length ? [...new Set(keys)] : POLICY_KEYS.delivery;
}

export function productTopic(query) {
  const text = normalise(query);
  if (CUE.precautions.test(text)) return 'precautions';
  if (SUITABILITY.test(text)) return 'suitability';
  if (CUE.warranty.test(text)) return 'warranty';
  if (CUE.claims.test(text)) return 'claims';
  if (CUE.returns.test(text)) return 'returns';
  if (CUE.usage.test(text)) return 'usage';
  return null;
}

// Country names come from the runtime's locale data, in every language the chat speaks. No country
// eligibility is encoded here: it remains a statement of the delivery policy.
const REGIONS = new Map();
for (const locale of SUPPORTED) {
  const display = new Intl.DisplayNames([locale], { type: 'region', fallback: 'none' });
  for (let a = 65; a <= 90; a += 1) for (let b = 65; b <= 90; b += 1) {
    const code = String.fromCharCode(a, b);
    // ICU also knows retired aliases (FX -> FR, SU -> RU). Keep canonical codes.
    if (new Intl.Locale(`und-${code}`).region !== code) continue;
    const name = display.of(code);
    if (name && name !== code) REGIONS.set(normalise(name), code);
  }
}
for (const pack of packs()) for (const [name, code] of Object.entries(pack.words.countryAliases ?? {})) REGIONS.set(name, code);

export function validCountry(value) {
  return typeof value === 'string' && /^[A-Z]{2}$/.test(value) && [...REGIONS.values()].includes(value) ? value : null;
}

export function countriesIn(query) {
  const text = ` ${normalise(query)} `;
  return [...new Set([...REGIONS].filter(([name]) => text.includes(` ${name} `)).map(([, code]) => code))];
}

/** A bare destination/ISO code is context, not evidence of a language switch. */
export function countryAnswer(query) {
  const text = normalise(query).replace(COUNTRY_LEAD, '');
  return REGIONS.get(text) ?? validCountry(text.toUpperCase());
}

export function countryForTurn(message, context = {}, history = []) {
  const answer = countryAnswer(message);
  if (answer) return { country: answer, ambiguous: false, explicit: true };
  const explicit = countriesIn(message);
  if (explicit.length) return { country: explicit.length === 1 ? explicit[0] : null, ambiguous: explicit.length > 1, explicit: true };
  // "Abroad" overrides a previously mentioned France, without inventing a destination.
  if (CUE.abroad.test(normalise(message))) return { country: null, ambiguous: false, explicit: true };
  const passive = validCountry(context.country);
  if (passive) return { country: passive, ambiguous: false, explicit: false };
  // Reuse a country only for a follow-up to delivery, not any country in old chat.
  for (const turn of history.slice(-6).reverse()) {
    if (turn.role !== 'user') continue;
    const previous = countriesIn(turn.content);
    if (policyTopics(turn.content).includes('delivery') && previous.length) return { country: previous.length === 1 ? previous[0] : null, ambiguous: previous.length > 1, explicit: false };
  }
  return { country: null, ambiguous: false, explicit: false };
}

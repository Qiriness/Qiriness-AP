// Storefront-only routing vocabulary and explicit bindings to existing keys.
// These are source identifiers, never copies of policy facts or parameter values.
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

const VOCABULARY = {
  delivery: ['livraison', 'livrer', 'livre', 'livrez', 'expedition', 'expedier', 'shipping', 'delivery', 'dispatch'],
  returns: ['retour', 'retours', 'retourner', 'renvoyer', 'retractation', 'return'],
  refunds: ['remboursement', 'rembourser', 'rembourse', 'remboursee', 'refund'],
  payments: ['payer', 'paiement', 'payement', 'payes', 'klarna', 'paypal', 'payment', 'pay'],
  cancellations: ['annuler', 'annulation', 'cancel', 'cancellation'],
  promotions: ['promo', 'promotions', 'promotion', 'reduction', 'remise', 'offres', 'discount', 'coupon'],
  privacy: ['confidentialite', 'rgpd', 'privacy'],
  order_changes: []
};

export function normalise(value) {
  return String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
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
  if (/\b(donnees personnelles|donnees privees|personal data)\b/.test(text) && !/\b(modifier|changer|edit|change)\b/.test(text)) found.push('privacy');
  if (/\b(modifier|changer|change|modification)\b/.test(text) && /\b(adresse|commande|address|order)\b/.test(text)) found.push('order_changes');
  if (/\b(cadeau|gift)\b/.test(text) && /\b(offre|promo|commande|gratuit|manquant|order|offer)\b/.test(text)) found.push('promotions');
  if (found.includes('order_changes') && /\b(adresse|address)\b/.test(text) && !/\b(delai|temps|cout|frais|time|cost)\b/.test(text)) return [...new Set(found.filter((t) => t !== 'delivery'))];
  return [...new Set(found)];
}

export function deliveryKeys(query) {
  const text = normalise(query);
  const keys = [];
  if (/\b(frais|cout|coute|cost|gratuite?|offerte?|seuil|threshold|port)\b/.test(text)) keys.push('shipping_cost_policy');
  if (/\b(pays|zone|destinations?|etranger|international|livrez|livrer|livre|ship to)\b/.test(text)) keys.push('delivery_location_policy');
  if (/\b(expedition|expedier|dispatch|preparation)\b/.test(text)) keys.push('dispatch_time_policy');
  if (/\b(delais?|temps|jours?|time|days|livraisson|livraison)\b/.test(text) && (!keys.length || /\b(delais?|temps|jours?|time|days)\b/.test(text)) && (!keys.includes('dispatch_time_policy') || /\b(livraison|delivery)\b/.test(text))) keys.push('delivery_time_policy');
  return keys.length ? [...new Set(keys)] : POLICY_KEYS.delivery;
}

export function productTopic(query) {
  const text = normalise(query);
  if (/\b(precautions?|restrictions?|contre indications?|interdit|danger|yeux|eyes|safety)\b/.test(text)) return 'precautions';
  if (/\b(enceinte|grossesse|allait|traitement|allerg|pregnan|suitab|convient)\w*/.test(text)) return 'suitability';
  if (/\b(garantie|warranty)\b/.test(text)) return 'warranty';
  if (/\b(efficacite|prouve|prouvee|resultats?|claims?|efficacy)\b/.test(text)) return 'claims';
  if (/\b(retour|retourner|ouverte?|utilisee?)\b/.test(text)) return 'returns';
  if (/\b(utiliser|utilisation|usage|matin|soir|seances?|nettoyer|charger|batterie|manuel|instructions?|use|morning|evening)\b/.test(text)) return 'usage';
  return null;
}

// Country names come from the runtime's French/English locale data. No country
// eligibility is encoded here: it remains a statement of the delivery policy.
const REGIONS = new Map();
for (const locale of ['fr', 'en']) {
  const display = new Intl.DisplayNames([locale], { type: 'region', fallback: 'none' });
  for (let a = 65; a <= 90; a += 1) for (let b = 65; b <= 90; b += 1) {
    const code = String.fromCharCode(a, b);
    // ICU also knows retired aliases (FX -> FR, SU -> RU). Keep canonical codes.
    if (new Intl.Locale(`und-${code}`).region !== code) continue;
    const name = display.of(code);
    if (name && name !== code) REGIONS.set(normalise(name), code);
  }
}
REGIONS.set('hollande', 'NL');
REGIONS.set('usa', 'US');

export function validCountry(value) {
  return typeof value === 'string' && /^[A-Z]{2}$/.test(value) && [...REGIONS.values()].includes(value) ? value : null;
}

export function countriesIn(query) {
  const text = ` ${normalise(query)} `;
  return [...new Set([...REGIONS].filter(([name]) => text.includes(` ${name} `)).map(([, code]) => code))];
}

/** A bare destination/ISO code is context, not evidence of a language switch. */
export function countryAnswer(query) {
  const text = normalise(query).replace(/^(?:(?:et|en|pour|vers|in|for|to|and)\s+)+/, '');
  return REGIONS.get(text) ?? validCountry(text.toUpperCase());
}

export function countryForTurn(message, context = {}, history = []) {
  const answer = countryAnswer(message);
  if (answer) return { country: answer, ambiguous: false, explicit: true };
  const explicit = countriesIn(message);
  if (explicit.length) return { country: explicit.length === 1 ? explicit[0] : null, ambiguous: explicit.length > 1, explicit: true };
  // "Abroad" overrides a previously mentioned France, without inventing a destination.
  if (/\b(etranger|international|abroad|outre mer|dom tom)\b/.test(normalise(message))) return { country: null, ambiguous: false, explicit: true };
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

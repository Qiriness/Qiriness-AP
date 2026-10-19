/**
 * THE ROUTINE CARDS (owner, 2026-10-18, from the screenshots « Vos quatre soins » / « Votre rituel,
 * matin et soir »): what the widget draws for a routine the builder finished. Built here from the
 * engine's two moments and the catalogue, never from the model's words, and never read to the model.
 *
 *   moments  the morning and the evening, BOTH always (« even if they didnt select jour et nuit »):
 *            the chosen one included; the other greyed, its steps they already have marked
 *            `owned`, the rest added by « Compléter ma routine » (« they can still have a night
 *            routine without buying extra »)
 *   steps    the ritual stage, the product (name, size, price, stars), « Pourquoi pour vous ? »
 *            (their skin type and concern the product suits, then its own short description: no
 *            model call), and the foldable « Ingrédients clés », « Bienfaits », « Application »
 *   discount the routine discount's percentage and minimum, for the « Économie » line. The code
 *            travels for the widget to apply, never shown (the banner says « appliquée
 *            automatiquement »)
 */

import { FIT } from '../advisory/reason-codes.mjs';
import { valueOf } from '../advisory/profile.mjs';

const MAX_TEXT = 1500;
const STAGES = new Set(['prepare', 'activate', 'optimise', 'regenerate']);

const clip = (text) => (typeof text === 'string' && text.trim() ? (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1).trimEnd()}…` : text.trim()) : null);

/** Their main concern's name in their language (« Rides »), else their routine's (the treat's sentence). */
export function concernName(profile, labels = {}, mainKey = null, lang = 'fr') {
  const name = (row) => (row ? row[lang] ?? row.fr ?? null : null);
  return name(labels.concerns?.[valueOf(profile, 'primary_concern')]) ?? name(labels.main?.[mainKey]) ?? null;
}

/** « Peau sèche · Rides »: what of theirs this product was chosen for (its skin and concern codes), in their language. */
export function whyTags(step, profile, labels = {}, mainKey = null, lang = 'fr') {
  const name = (row) => (row ? row[lang] ?? row.fr ?? null : null);
  const codes = new Set(step.reason_codes ?? []);
  const tags = [];
  const skin = valueOf(profile, 'skin_type');
  if (skin && codes.has(FIT.SKIN_TYPE_MATCH)) tags.push(name(labels.skin?.[skin]));
  if (codes.has(FIT.PRIMARY_CONCERN)) tags.push(name(labels.concerns?.[valueOf(profile, 'primary_concern')]) ?? name(labels.main?.[mainKey]));
  if (codes.has(FIT.SECONDARY_CONCERN)) {
    const eye = valueOf(profile, 'eye_concern');
    const others = [...(valueOf(profile, 'secondary_concerns') ?? []), ...(eye && eye !== 'none' ? [eye] : [])];
    tags.push(...others.map((c) => name(labels.concerns?.[c])).slice(0, 1));
  }
  return [...new Set(tags.filter(Boolean))];
}

/**
 * @param {{ advice: object, profile: object, byId: (id: string) => object | null, money: (n: number) => string,
 *   cartVariant: (p: object) => string | null, labels?: object, locale?: string, currency?: string,
 *   linkBase?: string, ref?: string | null, discount?: { code: string, min_products?: number } | null,
 *   reward?: { percentage: number, min_quantity?: number } | null }} input
 * @returns {object | null}
 */
export function buildRoutineView({ advice, profile, byId, money, cartVariant, labels = {}, locale = 'fr', currency = 'EUR', linkBase = '', ref = null, discount = null, reward = null }) {
  const m = advice?.moments;
  if (advice?.status !== 'recommended' || !m || !Array.isArray(m.day) || !Array.isArray(m.night)) return null;
  const lang = String(locale).startsWith('en') ? 'en' : 'fr';
  const card = (s, owned) => {
    const p = byId(s.product_id);
    if (!p) return null;
    const variant = cartVariant(p);
    // Several sizes: the one chosen for them (its price, its name on the card).
    const chosen = (p.variants ?? []).length > 1 ? p.variants.find((v) => v.id === variant) ?? null : null;
    const price = chosen ? chosen.price : p.priceFrom;
    return {
      product_id: p.id,
      handle: p.handle,
      title: p.name,
      url: `${linkBase}/products/${encodeURIComponent(p.handle)}`,
      variant_id: variant ?? null,
      ...(chosen?.title ? { variant_title: chosen.title } : {}),
      in_stock: Boolean(p.inStock),
      price: typeof price === 'number' ? money(price) : null,
      price_value: typeof price === 'number' ? price : null,
      volume: p.volume ?? null,
      rating: p.rating ?? null,
      rating_count: p.ratingCount ?? null,
      stage: STAGES.has(s.stage) ? s.stage : null,
      type: s.type ?? null,
      why: { tags: whyTags(s, profile, labels, advice.playbook?.key ?? null, lang), text: clip(p.short ?? p.description) },
      claims: p.claims ?? [],
      ingredients: clip(p.keyIngredients),
      benefits: clip(p.benefits),
      usage: clip(p.usage),
      // Already theirs from the chosen moment: shown, never bought twice.
      ...(owned ? { owned: true } : {}),
    };
  };
  const moment = (part) => {
    const chosen = m.chosen === 'both' || m.chosen === part;
    return {
      part,
      chosen,
      steps: m[part].map((s) => card(s, Boolean(s.also_in))).filter(Boolean),
    };
  };
  const moments = [moment('day'), moment('night')].filter((x) => x.steps.length);
  if (!moments.some((x) => x.chosen)) return null;
  const min = Math.max(discount?.min_products ?? 1, reward?.min_quantity ?? 1);
  return {
    ...(ref ? { ref } : {}),
    chosen: m.chosen,
    locale: lang,
    currency,
    moments,
    discount: discount?.code
      ? { code: discount.code, min_products: min, ...(typeof reward?.percentage === 'number' ? { percentage: reward.percentage } : {}) }
      : null,
  };
}

/**
 * One personalised routine, as kept for statistics (owner, 2026-10-17): its
 * number, the builder's answers and the products it gave. Anonymous: no name,
 * no customer, no session, no words, only the answers' codes
 * (`advisor_routines`, migration 98).
 *
 *   ref        a uuid made here: the conversation carries it (flow.routine_ref)
 *              so « Ajouter au panier » can mark the same row; the routine
 *              number is the table's own (`id`)
 *   answers    the main concern (the button's letter), the concern(s), the skin
 *              type or the eye routine's other eye concern, the age range, day /
 *              night / both, each with how it was given (button, typed, read)
 *
 * CHANNEL-FREE: the storefront writes it today, an email thread could later.
 */

import { randomUUID } from 'node:crypto';
import { valueOf } from './profile.mjs';

const FIELDS = ['primary_concern', 'skin_type', 'eye_concern', 'age_band', 'routine_time'];
const TIMES = new Set(['day', 'night', 'both']);

/** A finished day / night routine of the builder, or null when the advice is not one. */
export function isBuiltRoutine(advice, mode) {
  return mode === 'routine_builder' && advice?.status === 'recommended' && TIMES.has(advice.scope) && advice.steps?.length > 0;
}

/**
 * @param {{ advice: object, profile: object, channel: string, locale?: string, currency?: string | null, ref?: string }} input
 * @returns {object} the row, without the shop (the caller adds it)
 */
export function routineRecord({ advice, profile, channel, locale = 'fr', currency = null, ref = randomUUID() }) {
  const sources = Object.fromEntries(FIELDS.filter((f) => profile?.[f]?.source).map((f) => [f, profile[f].source]));
  return {
    ref,
    channel,
    locale: String(locale).slice(0, 2),
    main_concern: advice.playbook?.key ?? null,
    primary_concern: valueOf(profile, 'primary_concern'),
    secondary_concerns: valueOf(profile, 'secondary_concerns') ?? [],
    skin_type: valueOf(profile, 'skin_type'),
    eye_concern: valueOf(profile, 'eye_concern'),
    // The brand's range, also when they said their age in years (« j'ai 32 ans »): never the age itself.
    age_band: advice.age_range ?? valueOf(profile, 'age_band'),
    routine_time: advice.scope,
    answer_sources: sources,
    product_handles: advice.steps.map((s) => s.handle).filter(Boolean),
    total_price: typeof advice.total_price === 'number' ? advice.total_price : null,
    currency
  };
}

/**
 * Customer phrasing → profile updates, in every language the lexicon has a
 * table for (French and English: about 99 % of customers). Deterministic,
 * about a millisecond, before any model call: « J'ai la peau sèche et je
 * commence à avoir des rides » and « I have dry skin and I'm starting to get
 * wrinkles » both give skin_type dry and primary concern early_signs_of_ageing
 * without a tool round.
 *
 * LANGUAGE, NOT BRAND. The tables (lexicon-fr.mjs, lexicon-en.mjs) hold
 * ordinary skincare phrasing; the values they produce are the config's
 * vocabulary keys, and an update whose value the shop's config does not know
 * is dropped by `mergeProfile`. What the lexicon misses, the model adds
 * through the `advise` tool's profile_updates. A new language is a new table.
 *
 * ALL TABLES RUN ON EVERY MESSAGE. Customers mix (« j'ai des dark spots »),
 * and a one-word answer (« Tache », « Dry ») carries no language of its own.
 *
 * SPECIFIC BEFORE GENERAL, AND A MATCH CONSUMES ITS WORDS: « rides marquées »
 * is deep_wrinkles and does not also count as plain wrinkles.
 */

import { norm } from './text.mjs';
import { ingredientKey } from './ingredients.mjs';
import fr from './lexicon-fr.mjs';
import en from './lexicon-en.mjs';

export const LANGUAGES = [fr, en];

/**
 * Concern keys in matching order (specific first), with the eye-area concern
 * a word means when the conversation is about the eyes.
 */
const CONCERN_ORDER = [
  ['deep_wrinkles', 'advanced_eye_wrinkles'],
  ['early_signs_of_ageing', 'early_signs'],
  ['loss_of_density', null],
  ['loss_of_firmness', 'loss_of_firmness'],
  ['facial_contours', null],
  ['loss_of_tone', null],
  ['global_signs_of_ageing', 'mature_eye_area'],
  ['mature_skin', 'mature_eye_area'],
  ['regeneration', null],
  ['wrinkles', 'eye_wrinkles'],
  ['dark_spots', null],
  ['uneven_tone', null],
  ['redness', null],
  ['lack_of_radiance', null],
  ['dullness', null],
  ['dark_circles', 'dark_circles'],
  ['puffiness', 'puffiness'],
  ['tired_skin', 'tired_eyes'],
  ['dehydration', null],
  ['tightness', null],
  ['discomfort', null],
  ['dryness', null],
  ['clogged_pores', null],
  ['imperfections', null],
  ['excess_sebum', null],
  ['shine', null]
];
const SKIN_TYPE_ORDER = ['very_dry', 'dry', 'normal', 'combination', 'oily'];
const SENSITIVITY_ORDER = ['none', 'reactive', 'sensitive'];
const ROUTINE_STEP_ORDER = ['night_cream', 'eye_care', 'cleanser', 'serum', 'lotion', 'mask', 'moisturiser'];
const DESIRED_ORDER = ['serum', 'night_cream', 'eye_care', 'cleanser', 'mask', 'moisturiser'];
const SCOPE_ORDER = ['complete', 'complete_existing', 'essential', 'targeted'];
const REQUEST_ORDER = ['basic_routine', 'gift', 'spa'];

/** One pattern from every table's entry: (?:fr)|(?:en). */
function union(pick, flags = '') {
  const sources = LANGUAGES.map(pick).filter(Boolean).map((re) => `(?:${re.source})`);
  return sources.length ? new RegExp(sources.join('|'), flags) : null;
}
const keyed = (group, order) => order.map((key) => [key, union((l) => l[group][key])]).filter(([, re]) => re);

const L = {
  eyes: union((l) => l.areas.eyes),
  body: union((l) => l.areas.body),
  face: union((l) => l.areas.face),
  concerns: CONCERN_ORDER.map(([face, eye]) => [union((l) => l.concerns[face]), face, eye]).filter(([re]) => re),
  skinTypes: keyed('skinTypes', SKIN_TYPE_ORDER),
  men: union((l) => l.men),
  women: union((l) => l.women),
  sensitivity: keyed('sensitivity', SENSITIVITY_ORDER),
  exclusions: LANGUAGES.flatMap((l) => l.exclusions),
  routineNone: union((l) => l.routineNone),
  routineClauses: LANGUAGES.map((l) => l.routineClause),
  routineSteps: keyed('routineSteps', ROUTINE_STEP_ORDER),
  wants: union((l) => l.wants),
  desired: keyed('desired', DESIRED_ORDER),
  scope: keyed('scope', SCOPE_ORDER),
  requests: keyed('requests', REQUEST_ORDER),
  budgetSmall: union((l) => l.budgetSmall),
  moreOptions: union((l) => l.moreOptions),
  budgetAmount: LANGUAGES.flatMap((l) => l.budgetAmount ?? []),
  age: LANGUAGES.flatMap((l) => l.age),
  ageWords: LANGUAGES.flatMap((l) => l.ageWords),
  routineBuilder: union((l) => l.routineBuilder),
  dontKnow: union((l) => l.dontKnow)
};

export const ROUTINE_BUILDER = L.routineBuilder;

/** Every pattern, for the residue: what is left once they have all been removed. */
const ALL_PATTERNS = [
  L.eyes, L.body, L.face, L.men, L.women, L.routineNone, L.wants, L.routineBuilder, L.dontKnow,
  ...L.concerns.map(([re]) => re), ...L.skinTypes.map(([, re]) => re), ...L.sensitivity.map(([, re]) => re),
  ...L.routineSteps.map(([, re]) => re), ...L.desired.map(([, re]) => re), ...L.scope.map(([, re]) => re),
  ...L.requests.map(([, re]) => re), L.budgetSmall, L.moreOptions, ...L.budgetAmount,
  ...L.exclusions, ...L.routineClauses, ...L.age, ...L.ageWords.map(([re]) => re)
];
const NEUTRAL = new Set(LANGUAGES.flatMap((l) => [...l.markers, ...l.fillers]));

/**
 * The words of a message no pattern explains and that are not mere grammar or
 * filler: « my face feels like sandpaper » leaves « sandpaper ». Empty means
 * the lexicon read the whole message; anything left is for the model reader.
 */
export function residueOf(message) {
  let text = ` ${norm(message)} `;
  for (const re of ALL_PATTERNS) text = text.replace(new RegExp(re.source, 'g'), ' ');
  return text.split(' ').filter((w) => w.length > 1 && !/^\d+$/.test(w) && !NEUTRAL.has(w));
}

export function ageBand(age) {
  if (!Number.isFinite(age) || age < 12 || age > 110) return null;
  return age < 30 ? 'under_30' : age < 45 ? '30_44' : age < 60 ? '45_59' : '60_plus';
}

/**
 * The language a message is written in, when it says: its function words,
 * then its skincare words. Null for « Tache », « ok », a product name — the
 * caller keeps the conversation's language then.
 * @returns {'fr' | 'en' | null}
 */
export function detectLanguage(message) {
  const text = ` ${norm(message)} `;
  const words = text.trim().split(' ').filter(Boolean);
  const score = LANGUAGES.map((l) => {
    const markers = new Set(l.markers);
    let n = words.filter((w) => markers.has(w)).length;
    for (const re of Object.values(l.concerns)) if (re.test(text)) n += 1;
    for (const re of Object.values(l.skinTypes)) if (re.test(text)) n += 1;
    return { code: l.code, n };
  }).sort((a, b) => b.n - a.n);
  return score[0].n > 0 && score[0].n > score[1].n ? score[0].code : null;
}

/**
 * @param {string} message
 * @param {{ profile?: object, lastAsked?: string | null }} [context]
 * @returns {{ updates: { field: string, value: string, source: 'natural_language', confidence: string }[], routineBuilder: boolean, residue: string[] }}
 */
export function extractProfile(message, { profile = {}, lastAsked = null } = {}) {
  let text = ` ${norm(message)} `;
  const updates = [];
  const add = (field, value, confidence = 'medium', extra = {}) => updates.push({ field, value, source: 'natural_language', confidence, ...extra });
  const consume = (re) => { text = text.replace(new RegExp(re.source, 'g'), ' '); };

  // « je ne sais pas » answers the question just asked, nothing else.
  if (lastAsked && L.dontKnow.test(text)) add(lastAsked, 'unknown', 'high');

  // Area first: it decides which concern a word means (« rides » near « yeux »).
  const face = L.face.test(text);
  const eyes = L.eyes.test(text) && !face;
  const body = L.body.test(text);
  if (eyes) add('body_area', 'eyes', 'high');
  else if (body) add('body_area', 'body', 'high');
  else if (face) add('body_area', 'face', 'high');
  const eyeContext = eyes || (!body && !face && profile.body_area?.value === 'eyes');

  if (L.men.test(text)) add('sex_target', 'men', 'high');
  else if (L.women.test(text)) add('sex_target', 'women', 'high');

  const sensitivity = L.sensitivity.find(([, re]) => re.test(text));
  if (sensitivity) {
    add('sensitivity', sensitivity[0], 'high');
    // « pas sensible » must not leave « sensible » behind for a concern.
    if (sensitivity[0] === 'none') consume(sensitivity[1]);
  }

  // Not consumed: the window between « peau » and the type can hold a concern
  // (« peau déshydratée et mixte »).
  const skinType = L.skinTypes.find(([, re]) => re.test(text));
  if (skinType) add('skin_type', skinType[0], 'high');

  const exclusions = new Set(L.exclusions.flatMap((re) => [...text.matchAll(re)].map((m) => ingredientKey(m.groups.item))));
  for (const key of exclusions) add('known_exclusions', key, 'high');

  const routineClause = L.routineClauses.map((re) => text.match(re)).find(Boolean);
  if (L.routineNone.test(text)) add('current_routine', 'none', 'high');
  else if (routineClause) {
    let clause = routineClause.groups.clause;
    for (const [kind, re] of L.routineSteps) if (re.test(clause)) { add('current_routine', kind, 'high'); clause = clause.replace(new RegExp(re.source, 'g'), ' '); }
    text = text.replace(routineClause[0], ' ');
  }

  if (L.wants.test(text)) {
    const desired = L.desired.find(([, re]) => re.test(text));
    if (desired) add('desired_care_type', desired[0], 'medium');
  }

  const scope = L.scope.find(([, re]) => re.test(text));
  if (scope) add('routine_scope', scope[0], 'high');

  const request = L.requests.find(([, re]) => re.test(text));
  if (request) add('request', request[0], 'high');
  if (L.budgetSmall.test(text)) add('budget', 'small', 'high');
  const amount = L.budgetAmount.map((re) => text.match(re)).find(Boolean);
  // Under 5 is a count, not a price (« max 3 »).
  if (amount && Number(amount[1]) >= 5) add('budget_max', String(Number(amount[1])), 'high');

  const age = L.age.map((re) => text.match(re)).find(Boolean);
  const band = age ? ageBand(Number(age[1])) : ageBand(L.ageWords.find(([re]) => re.test(text))?.[1]);
  if (band) add('age_band', band, 'high');

  const found = [];
  for (const [re, faceConcern, eyeConcern] of L.concerns) {
    const m = text.match(re);
    if (!m) continue;
    const value = eyeContext && eyeConcern ? eyeConcern : faceConcern;
    if (value) found.push({ value, at: m.index });
    consume(re);
  }
  found.sort((a, b) => a.at - b.at);
  const hasPrimary = Boolean(profile.primary_concern?.value && profile.primary_concern.value !== 'unknown');
  found.forEach((c, i) => add(i === 0 && !hasPrimary ? 'primary_concern' : 'secondary_concerns', c.value, 'medium'));

  // Sensitivity said on its own is the concern: « j'ai la peau sensible ».
  const sens = updates.find((u) => u.field === 'sensitivity' && u.value !== 'none');
  if (sens && !found.length && !hasPrimary) add('primary_concern', sens.value === 'reactive' ? 'reactive_skin' : 'sensitivity', 'medium');

  // Dry skin on the body is a dryness concern: there is no « skin type » of the body.
  const st = updates.find((u) => u.field === 'skin_type');
  if (body && st && ['dry', 'very_dry'].includes(st.value) && !found.length && !hasPrimary) add('primary_concern', 'dryness', 'medium');

  return { updates, routineBuilder: L.routineBuilder.test(` ${norm(message)} `), moreOptions: L.moreOptions.test(` ${norm(message)} `), residue: residueOf(message) };
}

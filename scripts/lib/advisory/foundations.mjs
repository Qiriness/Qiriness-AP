/**
 * THE ROUTINE ENGINE ON FOUNDATIONS (docs/storefront-advisor-plan.md § 3.1–3.4;
 * decision « The routine engine follows the foundations », 2026-10-13).
 *
 * A routine is a foundation's ordered list of product TYPES; each step is
 * filled by the product of that type that best targets the customer's concern,
 * or combination of concerns (owner). Everything it knows comes from two data
 * sources, never from code: the brand's ROUTINES (foundations, sizes, modules,
 * concern map, questions, treats) and its PRODUCT KNOWLEDGE (type, concerns,
 * skin types, texture, sensitivity, men, premium, treat, gift, kit).
 *
 *   concerns     the customer's words → the brand's standard concerns (concern_map)
 *   foundation   a concern chosen with a button decides; otherwise each concern
 *                votes for its foundation, a dry skin votes for Hydration only
 *                when there is no other concern, ties go to foundation_priority;
 *                eye concerns alone: the eyes module; « routine de base »: G
 *   size         essential (daily required steps) · complete (every daily step
 *                + the relevant modules) · spa (+ occasional) · targeted (one
 *                step; outside the builder its two alternatives are shown with
 *                it as « our top choices », owner 2026-10-13);
 *                a small budget is essential
 *   owned        a type they already have is not doubled, unless the step is
 *                the one their concern needs (targets: primary)
 *   product      hard rules (stock, advisable, type, area, men, exclusions,
 *                skin « Non adapté », sensitive « Déconseillé »), then a score
 *   never pad    a step with no eligible product is said, never filled
 *   budget       « trop cher » just after ONE product: the cheapest product of
 *                the same type that still targets their concern, else a treat
 *                (owner, 2026-10-13); otherwise « petit budget » / « trop cher »
 *                gets a « petit plaisir » for their concern INSTEAD of a routine
 *                (owner: treats are cheaper); a ceiling (« moins de 60 € »): the routine trimmed to
 *                fit (optional steps first, the concern's step last), and a
 *                treat under it when even that step is over; with a budget, the
 *                cheaper of two products that fit about as well
 *
 * THE DAY / NIGHT ROUTINE (owner, 2026-10-16), when the routines carry
 * `routine_steps` (the brand's Routines tab): the builder asks the main
 * concern, the skin type, the age and day, night or both, every question even
 * when its answer does not change the routine (`questions.ask_all`, owner
 * 2026-10-17: the answers are statistics); no size, no products already used,
 * no required or optional step. A main concern may have its own steps and
 * questions (the eye routine, owner 2026-10-17: its other eye concern instead
 * of the skin type, the eyes a sensitive area). Each step is a product type (or several) in an
 * area, its product chosen by the step's criteria in order, the first deciding
 * first (`chosen_by`):
 *   range             the routine's range: the main concern's, by age for
 *                     anti-age, then the range of the serum chosen
 *   range_or_generic  that range's product, else one with no range (the eyes)
 *   concern           their main concern, then the main concern's others,
 *                     then their other concerns
 *   time              made for this moment (a night cream) before « matin et soir »
 *   skin              their skin type, sensitive skin, the cream's texture
 *   product           the step's own product (« Produit »), always; on a step
 *                     with other criteria, the product when none meets them
 * then the first type of the step (« Lotion, Nettoyant »: the lotion), then the
 * price. Hard rules: stock, advisable, type, area, men, exclusions, skin
 * « Non adapté », sensitive « Déconseillé », never outside its moment (a
 * « Soir » cream is not a day cream); `concern_required`: empty rather than a
 * product that does not treat the need. Both: the day, then the night without
 * what the day already has (the same product is not shown twice). Modules are
 * not added. Outside the builder, one product for one need, as before.
 *
 * Same advice shape as the playbook engine (recommend.mjs), which it replaces
 * for a shop that has routines and product knowledge (side by side, owner).
 * Channel-free: no prompt, no chip, no card.
 */

import { mergeProfile, valueOf, isAnswered } from './profile.mjs';
import { ingredientWords } from './ingredients.mjs';
import { hasPhrase, norm } from './text.mjs';
import { FIT, NO_MATCH, PINNED, SKIPPED, STATUS } from './reason-codes.mjs';
import { fillsStep, isBundle } from './product-knowledge.mjs';
import { fallbackChain, localized } from '../i18n/languages.mjs';

const MAX_BUILDER_QUESTIONS = 4;
/** Profile current_routine kinds → product types. */
const OWNED_TYPE = { cleanser: 'cleanser', moisturiser: 'cream', night_cream: 'cream', serum: 'serum', lotion: 'lotion', mask: 'mask', eye_care: 'eye', booster: 'serum' };
/** The engine's desired care types → product types. */
const DESIRED_TYPE = { cleanser: 'cleanser', moisturiser: 'cream', night_cream: 'cream', serum: 'serum', lotion: 'lotion', exfoliant: 'exfoliant', mask: 'mask', eye_care: 'eye', booster: 'serum' };
/** The engine's step kinds per product type, for the conversation layer (Phase 2's « already owned » and its prompts). */
const KIND = { cleanser: 'cleanser', makeup_remover: 'cleanser', lotion: 'lotion', exfoliant: 'lotion', serum: 'serum', cream: 'moisturiser', spf: 'spf', eye: 'eye_care', mask: 'mask', sheet_mask: 'mask', kit: 'kit' };
const QUESTION_FIELDS = { concern: 'primary_concern', skin_type: 'skin_type', eye_concern: 'eye_concern', sensitivity: 'sensitivity', current_routine: 'current_routine', size: 'routine_scope', age: 'age_band', routine_time: 'routine_time' };
/** A routine size the customer asked for: the day / night routine, not one product. */
const ROUTINE_SIZES = new Set(['essential', 'complete', 'spa', 'complete_existing']);
const SUIT = { ideal: 2, suitable: 1 };
const SENSITIVE_SUIT = { ideal: 2, suitable: 1, caution: 0 };
const QUESTION_OPTIONS = {
  skin_type: ['dry', 'normal', 'combination', 'oily', 'sensitive', 'unknown'],
  sensitivity: ['sensitive', 'none'],
  current_routine: ['none', 'moisturiser', 'cleanser+moisturiser', 'cleanser+serum+moisturiser'],
  routine_scope: ['essential', 'complete', 'spa', 'complete_existing'],
  routine_time: ['day', 'night', 'both'],
};
const OPPOSITE_TEXTURE = { rich: 'light', light: 'rich' };
/** The areas the face and eye routines cover; any other (hands, lips, feet, body) gets its own products. */
const ROUTINE_AREAS = new Set(['face', 'eyes']);
/** Never a product for one need on its own: a device, an accessory (kits and coffrets: isBundle). */
const NOT_ALONE = new Set(['device', 'tool']);

export const WEIGHTS = {
  primary: 1, primaryAmongOthers: 0.6, foundationConcern: 0.4, secondary: 0.3, secondaryCap: 0.6,
  skinIdeal: 0.3, skinSuitable: 0.1, texture: 0.3, textureMismatch: -0.3, preferredRange: 0.4, premiumRange: 0.6,
  sensitiveIdeal: 0.3, caution: -0.2, unjustifiedPremium: -1, men: 0.8, customerRange: 0.15,
  /** With a budget, a product this close to the best fit and cheaper takes its place. */
  budgetWindow: 0.15,
};
/** « Trop cher »: an alternative costs at most this share of the product they found too expensive. */
export const CHEAPER_RATIO = 0.9;

/**
 * @param {{ routines: object, catalogue: { products: object[] }, knowledge: Map<string, object>, allowed: object, question: Function }} deps
 *   question(field, values, locale, reason): the playbook advisor's chip builder (labels from the config)
 */
export function createFoundationAdvisor({ routines, catalogue, knowledge, allowed, question }) {
  const products = catalogue.products
    .map((p) => ({ id: p.id, handle: p.handle, name: p.name, product: p, k: knowledge.get(p.handle) ?? null }))
    .filter((x) => x.k);
  const byId = new Map(products.map((x) => [x.id, x]));
  const byHandle = new Map(products.map((x) => [x.handle, x]));
  const foundations = new Map(routines.foundations.map((f) => [f.key, f]));
  const concernOf = (key) => routines.concern_map?.[key] ?? key;
  // Words that also count as another concern (« rougeurs » → blemishes, and still a sensitive skin).
  const alsoOf = (key) => routines.concern_also?.[key] ?? [];
  const eyeConcerns = new Set(routines.eye_concerns ?? []);
  const sizeLabels = routines.questions?.chips?.size ?? {};
  // The day / night routine (the brand's Routines tab), when the routines carry it.
  const routineSteps = routines.routine_steps ?? null;
  const ageRanges = routines.age_ranges ?? [];
  const sensitiveConcerns = new Set(routines.sensitive_concerns ?? []);
  // The eye routine: a main concern with its own steps for the eyes (settings `area: eyes`).
  const eyeFoundation = routines.foundations.find((f) => f.area === 'eyes' && f.routine_steps) ?? null;
  const questions = routines.questions ?? {};

  /** Their age range, the brand's: a chip's, else the one their age in years falls in. */
  function ageRangeOf(profile) {
    const band = valueOf(profile, 'age_band');
    if (ageRanges.some((a) => a.key === band)) return band;
    const years = Number(valueOf(profile, 'age'));
    return (years && ageRanges.find((a) => years >= a.min && (a.max === null || years <= a.max))?.key) || null;
  }

  /** What the customer's profile says, in the brand's terms. */
  function read(profile) {
    const primaryRaw = valueOf(profile, 'primary_concern');
    const secondaryRaw = valueOf(profile, 'secondary_concerns') ?? [];
    const behaviours = valueOf(profile, 'skin_behaviour') ?? [];
    const raw = [primaryRaw, ...secondaryRaw, ...behaviours].filter(Boolean);
    const all = [...new Set([...raw.flatMap((x) => alsoOf(x)), ...raw.map(concernOf)])];
    const skin = valueOf(profile, 'skin_type');
    return {
      primaryChosen: profile.primary_concern?.source === 'quick_choice' ? concernOf(primaryRaw) : null,
      primarySource: profile.primary_concern?.source ?? null,
      primary: primaryRaw ? alsoOf(primaryRaw)[0] ?? concernOf(primaryRaw) : null,
      concerns: all,
      // The eye routine's other eye concern: counted once the eye routine is chosen, never a vote for another.
      eye: valueOf(profile, 'eye_concern'),
      premium: raw.some((c) => (routines.premium_concerns ?? []).includes(c)),
      // Sensitive is a skin type (owner, 2026-10-16): the sensitive column decides, not a skin column.
      skin: skin === 'very_dry' ? 'dry' : skin === 'sensitive' ? null : skin,
      sensitive: skin === 'sensitive' || ['sensitive', 'reactive'].includes(valueOf(profile, 'sensitivity')) || all.some((x) => sensitiveConcerns.has(x)),
      age: ageRangeOf(profile),
      time: valueOf(profile, 'routine_time'),
      men: valueOf(profile, 'sex_target') === 'men',
      exclusions: valueOf(profile, 'known_exclusions') ?? [],
      owned: (valueOf(profile, 'current_routine') ?? []).filter((x) => x !== 'none').map((x) => OWNED_TYPE[x]).filter(Boolean),
      desired: DESIRED_TYPE[valueOf(profile, 'desired_care_type')] ?? null,
      request: valueOf(profile, 'request'),
      budget: valueOf(profile, 'budget'),
      budgetMax: Number(valueOf(profile, 'budget_max')) || null,
      // Body care only when they said it: the model reader guessed « body » from « after showering »
      // (customer batch, EN) and the advice had nothing for a face.
      area: profile.body_area?.source === 'model_inferred' && valueOf(profile, 'body_area') === 'body' ? null : valueOf(profile, 'body_area'),
    };
  }

  /** The foundation (§ 3.1), or why there is none. */
  function chooseFoundation(c) {
    // The basic routine is the foundation given only on request, whatever its key (G, then H in Qiriness's sheet).
    if (c.request === 'basic_routine') {
      const basic = routines.foundations.find((f) => f.only_on_explicit_request);
      if (basic) return { key: basic.key };
    }
    // The hands, lips, feet or body (owner's notes v4, 2026-10-19): that area's products, no routine.
    if (c.area && !ROUTINE_AREAS.has(c.area)) return { area: c.area };
    const face = c.concerns.filter((x) => !eyeConcerns.has(x));
    const eyes = c.concerns.filter((x) => eyeConcerns.has(x));
    // « Cernes et poches » chosen with its button: the eye routine, whatever else they said.
    if (eyeFoundation && c.primaryChosen && eyeFoundation.primary_concerns.includes(c.primaryChosen)) return { key: eyeFoundation.key };
    if (!face.length && (eyes.length || c.area === 'eyes')) return eyes.length ? { key: eyeFoundation?.key ?? 'eyes' } : { missing: true };
    // The eyes asked about for a face concern (« un contour des yeux déshydraté »), outside a routine:
    // the eye products for it, none said honestly, never the face's (owner's notes v4: « SPECIFICALLY
    // asking about eyes, not getting an eye response »). A concern only the model reader guessed
    // ("best for the eye area" read as dehydration) is no answer: the eye question is asked.
    if (c.area === 'eyes' && !eyes.length && !c.builder) return c.primarySource === 'model_inferred' ? { missing: true } : { key: 'eyes', byArea: true };
    if (c.primaryChosen && !eyeConcerns.has(c.primaryChosen)) {
      const f = routines.foundations.find((x) => x.primary_concerns.includes(c.primaryChosen));
      if (f) return { key: f.key };
    }
    // Their other eye concern answered: they are in the eye routine (« Déshydratation » there is no vote for Hydration).
    if (eyeFoundation && c.eye && eyes.length) return { key: eyeFoundation.key };
    // One product of a type asked for: its concern breaks a tie (owner, 2026-10-19: « je veux une crème
    // pour les taches » after a routine for wrinkles kept « rides » a second concern, and the brand's
    // order chose an anti-wrinkle cream). A routine keeps the brand's order (§ 3.1).
    const votes = new Map();
    for (const concern of face) for (const f of routines.foundations) if (f.primary_concerns.includes(concern)) votes.set(f.key, (votes.get(f.key) ?? 0) + (c.desired && concern === c.primary ? 1.5 : 1));
    // A skin type picks the foundation that names it (dry → Hydration, oily → Oily skin)
    // only when nothing else is the main need; it stands for that foundation's concern.
    const bySkin = !votes.size && c.skin ? routines.foundations.find((f) => f.skin_types?.[c.skin]) : null;
    if (bySkin) return { key: bySkin.key, impliedConcern: bySkin.skin_types[c.skin] };
    if (!votes.size) return { missing: true };
    const order = routines.foundation_priority ?? [];
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]))[0][0];
    return { key: best };
  }

  /** The steps a size asks for (§ 3.2), over the foundation's ordered steps, with its modules. */
  function stepsFor(f, scope, c) {
    const daily = f.steps.filter((s) => s.frequency === 'daily');
    const modules = (routines.modules ?? []).filter((m) => m.type && !f.steps.some((s) => s.type === m.type) && m.when?.some((w) => c.concerns.includes(w)))
      .map((m, i) => ({ order: 100 + i, type: m.type, frequency: m.frequency, required: false, targets: 'module', module: m.key, when: m.when }));
    if (scope === 'targeted') {
      if (c.desired) return [f.steps.find((s) => s.type === c.desired) ?? { order: 1, type: c.desired, frequency: 'daily', required: true, targets: 'primary' }];
      // The day / night routine's types, the serum first: the first that has a product for the need
      // (no serum treats blemishes: their lotion).
      if (routineSteps) return [f.steps.find((s) => s.targets === 'primary' && products.some((x) => eligible(x, s, f, c, new Set()))) ?? f.steps[0]];
      return [f.steps.find((s) => s.targets === 'primary') ?? f.steps[0]];
    }
    if (scope === 'essential') return daily.filter((s) => s.required);
    const complete = [...daily, ...modules];
    return scope === 'spa' ? [...complete, ...f.steps.filter((s) => s.frequency === 'occasional')] : complete;
  }

  /** An ingredient they said they avoid (« sans rétinol »), in its name, actives, description or « contains ». */
  function excluded(x, c) {
    const text = norm(`${x.name} ${x.product.keyIngredients ?? ''} ${x.product.description ?? ''} ${(x.k.contains ?? []).join(' ')}`);
    return c.exclusions.some((e) => ingredientWords(e).some((w) => hasPhrase(text, w)));
  }

  function eligible(x, step, f, c, used) {
    const k = x.k;
    if (used.has(x.id) || k.status === 'do_not_advise' || !x.product.inStock) return false;
    // An eye step of the day / night routine takes its types (an eye serum, an eye cream).
    if (!(step.types ?? [step.type]).some((t) => fillsStep(k, t)) || isBundle(k)) return false;
    if ((step.area ?? (step.type === 'eye' ? 'eyes' : 'face')) !== (k.area ?? 'face')) return false;
    if (k.men && !c.men) return false;
    if (c.skin && k.skin?.[c.skin] === 'unsuitable') return false;
    if ((c.sensitive || f.tolerance_first) && k.sensitive === 'avoid') return false;
    if (excluded(x, c)) return false;
    const targets = [k.primary_concern, ...k.other_concerns];
    if (step.targets === 'primary' && f.primary_concerns.length && !targets.some((t) => f.primary_concerns.includes(t) || t === c.primary)) return false;
    if (step.targets === 'module' && !targets.some((t) => step.when.includes(t))) return false;
    return true;
  }

  /**
   * The products for a step. ONE PRODUCT FOR A NEED (owner, 2026-10-18: « skin type is not a priority,
   * the concern is; skin type helps narrow down between multiple products »): when nothing for their
   * need suits their skin type, the products for the need still count, marked; the skin type then only
   * ranks. Sensitivity and the ingredients they avoid stay hard. A routine keeps the skin type hard.
   */
  function targetedPool(step, f, c, used, scope) {
    const pool = products.filter((x) => eligible(x, step, f, c, used));
    if (pool.length || scope !== 'targeted' || !c.skin) return pool;
    const relaxed = products.filter((x) => eligible(x, step, f, { ...c, skin: null }, used));
    relaxed.skinRelaxed = true;
    return relaxed;
  }

  function score(x, step, f, c, ranges, skinRelaxed = false) {
    const k = x.k;
    const reasons = [];
    let s = 0;
    // Not made for their skin type (the step had nothing that is): ranked lower, and said.
    if (skinRelaxed && c.skin && k.skin?.[c.skin] === 'unsuitable') { s += WEIGHTS.textureMismatch; reasons.push(`${FIT.SKIN_TYPE_MISMATCH}:${c.skin}`); }
    const targets = [k.primary_concern, ...k.other_concerns];
    const primary = c.primary && !eyeConcerns.has(c.primary) || step.type === 'eye' ? c.primary : null;
    if (primary && k.primary_concern === primary) { s += WEIGHTS.primary; reasons.push(`${FIT.PRIMARY_CONCERN}:${primary}`); }
    else if (primary && k.other_concerns.includes(primary)) { s += WEIGHTS.primaryAmongOthers; reasons.push(`${FIT.PRIMARY_CONCERN}:${primary}`); }
    else if (targets.some((t) => f.primary_concerns.includes(t))) { s += WEIGHTS.foundationConcern; reasons.push(`${FIT.PRIMARY_CONCERN}:${targets.find((t) => f.primary_concerns.includes(t))}`); }
    let secondary = 0;
    for (const concern of c.concerns) if (concern !== primary && targets.includes(concern)) { secondary += WEIGHTS.secondary; reasons.push(`${FIT.SECONDARY_CONCERN}:${concern}`); }
    s += Math.min(secondary, WEIGHTS.secondaryCap);
    if (c.skin && k.skin?.[c.skin] === 'ideal') { s += WEIGHTS.skinIdeal; reasons.push(`${FIT.SKIN_TYPE_MATCH}:${c.skin}`); }
    else if (c.skin && k.skin?.[c.skin] === 'suitable') s += WEIGHTS.skinSuitable;
    const wanted = step.type === 'cream' ? f.texture ?? routines.skin_type_texture?.[c.skin] ?? (c.concerns.includes('dryness') ? 'rich' : null) : null;
    if (wanted && k.texture === wanted) { s += WEIGHTS.texture; reasons.push(`${FIT.TEXTURE_MATCH}:${wanted}`); }
    else if (wanted && k.texture === OPPOSITE_TEXTURE[wanted]) { s += WEIGHTS.textureMismatch; reasons.push(`${FIT.TEXTURE_MISMATCH}:${k.texture}`); }
    if (k.range && k.range === f.preferred_range) { s += WEIGHTS.preferredRange; reasons.push(`${FIT.PREFERRED_FAMILY}:${k.range}`); }
    if (c.premium && k.range && k.range === f.premium_variant) { s += WEIGHTS.premiumRange; reasons.push(`${FIT.PREFERRED_FAMILY}:${k.range}`); }
    if (k.premium && !c.premium) s += WEIGHTS.unjustifiedPremium;
    if ((c.sensitive || f.tolerance_first) && k.sensitive === 'caution') s += WEIGHTS.caution;
    if (c.sensitive && k.sensitive === 'ideal') { s += WEIGHTS.sensitiveIdeal; reasons.push(FIT.SENSITIVE_SKIN_MATCH); }
    else if (c.sensitive && k.sensitive === 'suitable') reasons.push(FIT.SENSITIVE_SKIN_MATCH);
    if (c.men && k.men) s += WEIGHTS.men;
    if (k.range && ranges.has(k.range)) { s += WEIGHTS.customerRange; reasons.push(`${FIT.CUSTOMER_RANGE}:${k.range}`); }
    return { s: Math.round(s * 1000) / 1000, reasons };
  }

  /** Products they build around: the step of their type (a kit, its contents). */
  function ownedProducts(ids) {
    return ids.flatMap((id) => {
      const x = byId.get(id);
      if (!x) return [];
      return isBundle(x.k) && x.k.kit_contents.length ? x.k.kit_contents.map((h) => byHandle.get(h)).filter(Boolean) : [x];
    });
  }

  /** One routine: a foundation's steps for a size, filled. */
  function evaluate(profile, mode, { owned = [], ranges = new Set(), pinned = [], exclude = [], areaOff = false } = {}) {
    const c = read(profile);
    c.builder = mode === 'routine_builder';
    // The builder builds the face's routine: a hand or body area said earlier does not stop it.
    if (areaOff || (c.builder && c.area && !ROUTINE_AREAS.has(c.area))) c.area = null;
    const choice = chooseFoundation(c);
    if (choice.none) return { none: choice.none };
    if (choice.area) return areaChoice(profile, mode, c, choice.area, { owned, ranges, pinned, exclude });
    if (choice.missing) return { missing: true };
    if (choice.impliedConcern && !c.primary) { c.primary = choice.impliedConcern; c.concerns = [...c.concerns, choice.impliedConcern]; }

    const scopeSaid = valueOf(profile, 'routine_scope');
    const wantsRoutine = Boolean(routineSteps) && !c.desired && scopeSaid !== 'targeted' && (mode === 'routine_builder' || Boolean(c.time) || ROUTINE_SIZES.has(scopeSaid));
    // The eyes alone, outside a routine: one eye product, of the day / night routine's eye step types too (an eye serum, an eye cream).
    const eyesAlone = choice.key === 'eyes' || (foundations.get(choice.key)?.area === 'eyes' && !wantsRoutine);
    const eyeTypes = ['eye', ...(routineSteps?.day ?? []).filter((s) => s.area === 'eyes').flatMap((s) => s.types)];
    let f = eyesAlone
      ? { key: 'eyes', name_fr: 'Yeux', primary_concerns: choice.byArea ? c.concerns : c.concerns.filter((x) => eyeConcerns.has(x)), steps: [{ order: 1, type: 'eye', types: [...new Set(eyeTypes)], area: 'eyes', frequency: 'daily', required: true, targets: 'primary' }] }
      : foundations.get(choice.key);
    if (eyesAlone && !eyeConcerns.has(c.primary)) c.primary = f.primary_concerns[0];
    // The eye routine: its other eye concern counts, the eyes are sensitive, no skin type.
    if (!eyesAlone && f.area === 'eyes') {
      if (!f.primary_concerns.includes(c.primary)) c.primary = c.concerns.find((x) => f.primary_concerns.includes(x)) ?? f.primary_concerns[0];
      if (c.eye && c.eye !== 'none') c.concerns = [...new Set([...c.concerns, concernOf(c.eye)])];
      c.sensitive = c.sensitive || Boolean(f.sensitive);
      c.skin = null;
    }
    // The anti-age range by age: the routine's range, and premium allowed when it is the age's.
    const range = rangeFor(f, c);
    if (f.range_by_age && range) { f = { ...f, preferred_range: range }; c.premium = c.premium || Boolean(c.age); }
    if (wantsRoutine && !eyesAlone) return timed(f, c, range, { ranges, pinned, exclude });
    let scope = scopeSaid ?? (mode === 'routine_builder' ? 'essential' : 'targeted');
    if (scope === 'complete_existing') scope = 'complete';
    if (c.budget === 'small' && scope !== 'targeted') scope = 'essential';
    if (eyesAlone && scope !== 'targeted' && mode !== 'routine_builder') scope = 'targeted';

    const used = new Set(exclude);
    const mine = ownedProducts(owned);
    for (const x of mine) used.add(x.id);
    const wanted = pinned.map((id) => byId.get(id)).filter((x) => x && !used.has(x.id));
    let plan = stepsFor(f, scope, c);
    // A product they came for brings its step in when the size has none (§ the routine flow).
    for (const x of wanted) {
      if (!plan.some((s) => fillsStep(x.k, s.type))) {
        const extra = f.steps.find((s) => fillsStep(x.k, s.type));
        if (extra && scope !== 'targeted') plan = [...plan, extra];
        if (extra && scope === 'targeted') plan = [extra];
      }
    }
    const placed = [];
    const steps = [];
    const skipped = [];
    const ownedTypes = [...c.owned];
    for (const step of plan) {
      const slot = step.module ? `module_${step.module}` : `${step.type}_${step.order}`;
      const kind = KIND[step.type] ?? step.type;
      const optional = !step.required;
      const theirs = mine.find((x) => fillsStep(x.k, step.type));
      if (theirs) {
        mine.splice(mine.indexOf(theirs), 1);
        skipped.push({ slot, kind, reason: SKIPPED.ALREADY_OWNED, product_id: theirs.id, handle: theirs.handle });
        continue;
      }
      const ownedAt = ownedTypes.indexOf(step.type);
      let keptForConcern = false;
      if (ownedAt >= 0 && step.type !== c.desired) {
        ownedTypes.splice(ownedAt, 1);
        // Their own product of this type, unless their concern needs a specific one here.
        if (step.targets !== 'primary') { skipped.push({ slot, kind, reason: SKIPPED.ALREADY_IN_ROUTINE }); continue; }
        keptForConcern = true;
      }
      const pin = wanted.find((x) => fillsStep(x.k, step.type) && !used.has(x.id));
      const reachable = targetedPool(step, f, c, used, scope);
      // The eyes alone and no eye care made for their concern (« poches »: only the roller, an accessory;
      // owner, 2026-10-19: « autre category should not be prioritised over an actual soin »): the eye care
      // the day / night routine's eye step chooses, which needs no concern (the range's, else a generic one).
      // An eye concern only: « des taches sur le contour des yeux » still gets none, said honestly.
      const eyeStep = eyesAlone && !reachable.length && eyeConcerns.has(c.primary) ?routineSteps?.day?.find((s) => s.area === 'eyes' && !s.concern_required) : null;
      const eyeCare = eyeStep
        ? products.filter((x) => eligible(x, { ...step, types: eyeStep.types, targets: null }, f, c, used)).map((x) => ({ x, ...timedKey(x, eyeStep, 'day', f, c, range), s: 0, reasons: [] })).sort(byKey)
        : [];
      // No accessory beside it (owner, 2026-10-29: « should not propose accessories unless explicitly
      // asked »): one asked for by name is the resolver's, not the engine's.
      // One product for a need: the products that treat their concern first, when there are any
      // (« un produit pour les taches » ranked an anti-fatigue serum first, on its range's concerns).
      const treating = scope === 'targeted' && c.primary && !eyesAlone ? reachable.filter((x) => [x.k.primary_concern, ...x.k.other_concerns].includes(c.primary)) : [];
      const pool = treating.length ? Object.assign(treating, { skinRelaxed: reachable.skinRelaxed }) : reachable;
      // A man: his range first among the suitable products (owner: « ranked first, others still
      // possible »); a sensitive-skin cleanser outscored the men's one in the customer batch.
      const menFirst = (x) => (c.men && x.k.men ? 1 : 0);
      const ranked = eyeCare.length ? eyeCare.map((r) => ({ ...r, reasons: r.codes })) : pool.map((x) => ({ x, ...score(x, step, f, c, ranges, pool.skinRelaxed) }))
        .sort((a, b) => menFirst(b.x) - menFirst(a.x) || b.s - a.s || (a.x.product.priceFrom ?? 0) - (b.x.product.priceFrom ?? 0) || a.x.name.localeCompare(b.x.name));
      if (pin) {
        const at = ranked.findIndex((r) => r.x.id === pin.id);
        if (at > 0) ranked.unshift(...ranked.splice(at, 1));
        placed.push({ product_id: pin.id, handle: pin.handle, status: at >= 0 ? PINNED.PLACED : PINNED.UNSUITABLE });
        if (at >= 0) ranked[0].reasons = [...ranked[0].reasons, FIT.CUSTOMER_INTEREST];
      }
      if (!ranked.length) { skipped.push({ slot, kind, reason: SKIPPED.NO_ELIGIBLE_PRODUCT, optional }); continue; }
      // With a budget: the cheapest of the products that fit about as well as the best.
      if ((c.budget || c.budgetMax) && !pin) {
        const close = ranked.filter((r) => r.s >= ranked[0].s - WEIGHTS.budgetWindow);
        const cheapest = close.reduce((a, b) => ((b.x.product.priceFrom ?? Infinity) < (a.x.product.priceFrom ?? Infinity) ? b : a));
        if (cheapest !== ranked[0]) { ranked.splice(ranked.indexOf(cheapest), 1); ranked.unshift(cheapest); }
      }
      const [top, ...rest] = ranked;
      used.add(top.x.id);
      steps.push({
        slot, kind, type: step.type, optional,
        product_id: top.x.id, handle: top.x.handle,
        alternatives: rest.slice(0, 2).map((r) => ({ product_id: r.x.id, handle: r.x.handle })),
        reason_codes: [...top.reasons, ...(keptForConcern ? [FIT.CONCERN_NEEDS_SPECIFIC_PRODUCT] : [])],
        merchandised: null,
        ...(pin && top.x.id === pin.id ? { customer_interest: true } : {}),
        scores: { suitability: top.s, routine_fit: 0, total: top.s },
      });
    }
    // A REQUIRED STEP WITH NO PRODUCT IS REPLACED by the foundation's next
    // optional step that has one, without asking (owner, 2026-10-16: imperfections
    // with a cleanser and a cream owned got « nothing to add »; the patch was there).
    const empty = skipped.filter((s) => s.reason === SKIPPED.NO_ELIGIBLE_PRODUCT && !s.optional).length;
    if (empty && scope !== 'targeted') {
      let replaced = 0;
      for (const step of f.steps.filter((s) => !s.required && !plan.includes(s))) {
        if (replaced >= empty) break;
        if (c.owned.includes(step.type) || mine.some((x) => fillsStep(x.k, step.type))) continue;
        const ranked = products.filter((x) => eligible(x, step, f, c, used)).map((x) => ({ x, ...score(x, step, f, c, ranges) }))
          .sort((a, b) => b.s - a.s || (a.x.product.priceFrom ?? 0) - (b.x.product.priceFrom ?? 0) || a.x.name.localeCompare(b.x.name));
        if (!ranked.length) continue;
        const [top, ...rest] = ranked;
        used.add(top.x.id);
        replaced += 1;
        steps.push({
          slot: `${step.type}_${step.order}`, kind: KIND[step.type] ?? step.type, type: step.type, optional: true,
          product_id: top.x.id, handle: top.x.handle,
          alternatives: rest.slice(0, 2).map((r) => ({ product_id: r.x.id, handle: r.x.handle })),
          reason_codes: [...top.reasons, FIT.REPLACES_MISSING_STEP],
          merchandised: null,
          scores: { suitability: top.s, routine_fit: 0, total: top.s },
        });
      }
    }
    for (const x of wanted) if (!placed.some((p) => p.product_id === x.id)) placed.push({ product_id: x.id, handle: x.handle, status: PINNED.NO_STEP });
    const budget = c.budgetMax ? withinBudget(steps, skipped, plan, c.budgetMax) : null;
    // OUR TOP CHOICES for one need, outside the builder (owner): the best product
    // of each type that targets it, not three of one type. A type they asked
    // for (« juste un sérum ») keeps its own alternatives.
    if (scope === 'targeted' && mode !== 'routine_builder' && !c.desired && steps.length === 1 && !eyesAlone) {
      const others = f.steps
        // A cleanser is a top choice only where the foundation says it treats the need (Imperfections).
        .filter((s) => s.frequency === 'daily' && s.type !== steps[0].type && !c.owned.includes(s.type) && (s.type !== 'cleanser' || s.targets === 'primary'))
        .map((s) => { const pool = targetedPool({ ...s, targets: 'primary' }, f, c, used, scope); return pool.map((x) => ({ x, ...score(x, s, f, c, ranges, pool.skinRelaxed) })).filter((r) => [r.x.k.primary_concern, ...r.x.k.other_concerns].includes(c.primary)); })
          .map((list) => list
          .sort((a, b) => b.s - a.s || a.x.product.priceFrom - b.x.product.priceFrom)[0])
        .filter(Boolean)
        .sort((a, b) => b.s - a.s)
        .slice(0, 2);
      if (others.length) steps[0] = { ...steps[0], alternatives: others.map((r) => ({ product_id: r.x.id, handle: r.x.handle })) };
    }
    // THE TYPE ASKED FOR HAS NOTHING FOR THE CONCERN (owner, 2026-10-19: « est-ce que vous avez un
    // sérum pour les taches » got an anti-fatigue serum, the spot serum being out of stock, then
    // « je ne trouve pas » three times). The best product of another type that treats it takes its
    // place, and the out-of-stock ones of that type are named, so the reply says so.
    let askedType = null;
    const treats = (x) => [x.k.primary_concern, ...x.k.other_concerns].includes(c.primary);
    if (scope === 'targeted' && mode !== 'routine_builder' && c.primary && !eyesAlone && !wanted.length && steps.length <= 1 && !(steps[0] && treats(byId.get(steps[0].product_id)))) {
      const outOfStock = products.filter((x) => !x.product.inStock && fillsStep(x.k, c.desired) && x.k.status !== 'do_not_advise' && !isBundle(x.k) && x.k.primary_concern === c.primary);
      const other = f.steps
        .filter((s) => s.frequency === 'daily' && s.type !== (c.desired ?? steps[0]?.type) && !c.owned.includes(s.type))
        .flatMap((s) => targetedPool({ ...s, targets: 'primary' }, f, c, new Set(exclude), scope).filter(treats).map((x) => ({ x, step: s, ...score(x, s, f, c, ranges) })))
        .sort((a, b) => b.s - a.s || (a.x.product.priceFrom ?? 0) - (b.x.product.priceFrom ?? 0) || a.x.name.localeCompare(b.x.name));
      if (other.length) {
        const [top, ...rest] = other;
        steps.splice(0, steps.length, {
          slot: `${top.step.type}_${top.step.order}`, kind: KIND[top.step.type] ?? top.step.type, type: top.step.type, optional: false,
          product_id: top.x.id, handle: top.x.handle,
          alternatives: rest.filter((r) => r.x.id !== top.x.id).slice(0, 2).map((r) => ({ product_id: r.x.id, handle: r.x.handle })),
          reason_codes: [...top.reasons, ...(c.desired ? [FIT.ASKED_TYPE_UNAVAILABLE] : [])],
          merchandised: null,
          scores: { suitability: top.s, routine_fit: 0, total: top.s },
        });
      }
      if (c.desired) askedType = { type: c.desired, out_of_stock: outOfStock.map((x) => x.id), replaced: other.length > 0 };
    }
    return { f, scope, steps, skipped, pinned: placed, c, budget, askedType };
  }

  /**
   * THE HANDS, LIPS, FEET, BODY (owner's notes v4, 2026-10-19: « should prioritise a hand cream over a face
   * cream »; « it should suggest the body lotions, creams or lait »). No routine: up to three of that area's
   * products for the need, best first: their concern as the product's main one, among its others, then a
   * concern of the same main concern (« sèches » is Hydration, as the hand cream's « Déshydratation »); the
   * daily care before an occasional one (the hand cream before the hand mask). An « Autre » (a shower oil)
   * only when it treats the need itself, last; never a kit, a coffret, a device. Nothing there: the brand's `area_fallback` for that need (the face cream for dry hands or
   * lips, owner), else nothing, said.
   */
  function areaChoice(profile, mode, c, area, opts) {
    if (!c.primary) return { areaMissing: area };
    const f = { key: `area_${area}`, name_fr: area, primary_concerns: [c.primary], steps: [] };
    const skip = new Set(opts.exclude ?? []);
    const family = routines.foundations.filter((x) => x.primary_concerns.includes(c.primary)).flatMap((x) => x.primary_concerns);
    const fit = (k) => {
      const targets = [k.primary_concern, ...k.other_concerns];
      if (k.primary_concern === c.primary) return { s: 3, code: c.primary };
      if (k.other_concerns.includes(c.primary)) return { s: 2, code: c.primary };
      const near = targets.find((t) => family.includes(t));
      return near ? { s: 1, code: near } : { s: 0 };
    };
    // An « Autre » after the care products, an occasional one (a hand mask) after the daily ones (the hand cream).
    const other = (x) => (x.k.functional_type === 'out_of_routine' ? 2 : x.k.frequency === 'occasional' ? 1 : 0);
    const ranked = products
      .filter((x) => (x.k.area ?? 'face') === area && !isBundle(x.k) && !NOT_ALONE.has(x.k.functional_type) && !skip.has(x.id) && suitable(x, { ...c, skin: null }))
      .map((x) => ({ x, ...fit(x.k) }))
      .filter((r) => r.s >= (other(r.x) === 2 ? 2 : 1))
      .sort((a, b) => other(a.x) - other(b.x) || b.s - a.s || (a.x.product.priceFrom ?? 0) - (b.x.product.priceFrom ?? 0) || a.x.name.localeCompare(b.x.name));
    const none = { f, scope: 'targeted', steps: [], skipped: [], pinned: [], c, budget: null, area };
    if (!ranked.length) {
      const fallback = routines.area_fallback?.[area];
      if (fallback?.to !== 'face' || !(fallback.concerns ?? []).includes(c.primary)) return none;
      const face = evaluate(profile, mode, { ...opts, areaOff: true });
      return face.steps?.length ? { ...face, areaFallback: { from: area, to: 'face' } } : none;
    }
    const [top, ...rest] = ranked;
    const type = top.x.k.functional_type;
    return {
      ...none,
      steps: [{
        slot: `${area}_1`, kind: KIND[type] ?? type, type, optional: false,
        product_id: top.x.id, handle: top.x.handle,
        alternatives: rest.slice(0, 2).map((r) => ({ product_id: r.x.id, handle: r.x.handle })),
        reason_codes: [`${FIT.PRIMARY_CONCERN}:${top.code}`],
        merchandised: null,
        scores: { suitability: top.s, routine_fit: 0, total: top.s },
      }],
    };
  }

  /**
   * EXAMPLES OF A TYPE (owner's notes v4: « it should give more than one example … prioritise the creams or
   * the serums that are in a gamme »): a care type asked for, their concern asked and still open. Up to three
   * of that type for the face, one per range first, products in a range before the others.
   */
  function typeExamples(c) {
    const pool = products
      .filter((x) => fillsStep(x.k, c.desired) && !isBundle(x.k) && (x.k.area ?? 'face') === 'face' && suitable(x, c))
      .sort((a, b) => Boolean(b.k.range) - Boolean(a.k.range) || Number(c.men && b.k.men) - Number(c.men && a.k.men) || skinFit(b.k, c).score - skinFit(a.k, c).score
        || Boolean(a.k.premium) - Boolean(b.k.premium) || (a.product.priceFrom ?? 0) - (b.product.priceFrom ?? 0) || a.name.localeCompare(b.name));
    const ranges = new Set();
    const picked = [];
    for (const x of pool) if (picked.length < 3 && (!x.k.range || !ranges.has(x.k.range))) { picked.push(x); if (x.k.range) ranges.add(x.k.range); }
    for (const x of pool) if (picked.length < 3 && !picked.includes(x)) picked.push(x);
    if (!picked.length) return null;
    const [top, ...rest] = picked;
    return [{ slot: `${c.desired}_examples`, kind: KIND[c.desired] ?? c.desired, type: c.desired, optional: false, product_id: top.id, handle: top.handle, alternatives: rest.map((x) => ({ product_id: x.id, handle: x.handle })), reason_codes: ['type_example'], merchandised: null, scores: { suitability: 0, routine_fit: 0, total: 0 } }];
  }

  /** The routine's range: the main concern's, or by their age for anti-age (Rules tab). */
  function rangeFor(f, c) {
    if (!f?.range_by_age) return f?.preferred_range ?? null;
    return ageRanges.find((a) => a.key === c.age)?.range ?? f.preferred_range ?? null;
  }

  /** How well a product treats the need: their main concern 3, among its others 2, the main concern's others 1; their other concerns a little. */
  function concernFit(k, f, c) {
    const targets = [k.primary_concern, ...k.other_concerns];
    const codes = [];
    let score = 0;
    if (c.primary && k.primary_concern === c.primary) { score = 3; codes.push(`${FIT.PRIMARY_CONCERN}:${c.primary}`); }
    else if (c.primary && k.other_concerns.includes(c.primary)) { score = 2; codes.push(`${FIT.PRIMARY_CONCERN}:${c.primary}`); }
    else {
      // The main concerns whose range is by age are one family: age chooses the range, not the
      // concern (« Ridules » under 25 or « Rides » after: owner, 2026-10-16).
      // A main concern with its own steps (the eye routine) is its own family.
      const family = f.range_by_age && !f.routine_steps ? routines.foundations.filter((x) => x.range_by_age && !x.routine_steps).flatMap((x) => x.primary_concerns) : f.primary_concerns;
      const near = targets.find((t) => family.includes(t));
      if (near) { score = 1; codes.push(`${FIT.PRIMARY_CONCERN}:${near}`); }
    }
    // Their other concerns, and a sensitive skin's (« Réactivité » on a gentle cleanser).
    const others = new Set([...c.concerns, ...(c.sensitive ? sensitiveConcerns : [])]);
    others.delete(c.primary);
    let more = 0;
    for (const t of targets) if (others.has(t)) { more += 0.1; codes.push(`${FIT.SECONDARY_CONCERN}:${t}`); }
    return { score: score + Math.min(more, 0.3), codes };
  }

  /** Their skin: its column (« Idéal » 2, « Adapté » 1), the sensitive column, a cream's texture. */
  function skinFit(k, c) {
    const codes = [];
    let score = 0;
    if (c.skin) {
      score += SUIT[k.skin?.[c.skin]] ?? 0;
      if (k.skin?.[c.skin] === 'ideal') codes.push(`${FIT.SKIN_TYPE_MATCH}:${c.skin}`);
    }
    if (c.sensitive) {
      score += SENSITIVE_SUIT[k.sensitive] ?? 0;
      if (k.sensitive === 'ideal' || k.sensitive === 'suitable') codes.push(FIT.SENSITIVE_SKIN_MATCH);
    }
    const wanted = k.functional_type === 'cream' ? routines.skin_type_texture?.[c.skin] : null;
    if (wanted && k.texture === wanted) { score += 0.5; codes.push(`${FIT.TEXTURE_MATCH}:${wanted}`); }
    else if (wanted && k.texture === OPPOSITE_TEXTURE[wanted]) { score -= 0.5; codes.push(`${FIT.TEXTURE_MISMATCH}:${k.texture}`); }
    return { score, codes };
  }

  /** The hard rules every product meets, a step's own product too: advisable, in stock, men, skin, sensitive, exclusions. */
  function suitable(x, c) {
    const k = x.k;
    if (k.status === 'do_not_advise' || !x.product.inStock) return false;
    if (k.men && !c.men) return false;
    if (c.skin && k.skin?.[c.skin] === 'unsuitable') return false;
    if (c.sensitive && k.sensitive === 'avoid') return false;
    return !excluded(x, c);
  }

  /** A product for this step of the day or night routine: the hard rules. */
  function timedEligible(x, step, part, f, c, range) {
    const k = x.k;
    if (isBundle(k) || !suitable(x, c)) return false;
    if (!step.types.includes(k.functional_type) || (k.area ?? 'face') !== step.area) return false;
    // Never outside its moment: a « Soir » cream is not a day cream, a « Matin » one not a night cream.
    if (k.time_of_day === (part === 'day' ? 'evening' : 'morning')) return false;
    // A step with a product to fall back on (the eye cream): only the range's, only for one of their
    // concerns; otherwise that product (owner, 2026-10-17).
    if (step.product) {
      if (step.chosen_by.includes('range') && range && k.range !== range) return false;
      return !step.concern_required || [k.primary_concern, ...k.other_concerns].some((t) => c.concerns.includes(t));
    }
    return !step.concern_required || concernFit(k, f, c).score >= 1;
  }

  /** The step's own product (« Produit »): always it (`step_product`), or when no product met the criteria (`step_fallback`). */
  function stepProduct(step, code, skip, c) {
    const x = byHandle.get(step.product);
    return x && !skip.has(x.id) && suitable(x, c) ? { x, key: [0, 0, 0], codes: [code] } : null;
  }

  /** The step's criteria in order, as numbers compared left to right, with their reason codes. */
  function timedKey(x, step, part, f, c, range) {
    const k = x.k;
    const key = [c.men && k.men ? 1 : 0];
    const codes = [];
    for (const criterion of step.chosen_by) {
      if (criterion === 'range' || criterion === 'range_or_generic') {
        const same = Boolean(range) && k.range === range;
        key.push(criterion === 'range' ? Number(same) : same ? 2 : k.range ? 0 : 1);
        if (same) codes.push(`${FIT.PREFERRED_FAMILY}:${range}`, ...(f.range_by_age && c.age ? [`${FIT.AGE_RANGE}:${c.age}`] : []));
      } else if (criterion === 'concern') {
        const fit = concernFit(k, f, c);
        key.push(fit.score);
        codes.push(...fit.codes);
      } else if (criterion === 'time') {
        // The range's own night (or day) version: with no range, any night cream would come first
        // (Temps Sublime's anti-age night cream for blemishes).
        const made = Boolean(range) && k.range === range && k.time_of_day === (part === 'day' ? 'morning' : 'evening');
        key.push(Number(made));
        if (made) codes.push(`${FIT.MADE_FOR_TIME}:${part}`);
      } else if (criterion === 'skin') {
        const fit = skinFit(k, c);
        key.push(fit.score);
        codes.push(...fit.codes);
      }
    }
    // Then the step's first type (« Lotion, Nettoyant »: the lotion), then the price.
    key.push(-step.types.indexOf(k.functional_type), -(x.product.priceFrom ?? 0));
    return { key, codes: [...new Set(codes)] };
  }

  const byKey = (a, b) => {
    for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return b.key[i] - a.key[i];
    return a.x.name.localeCompare(b.x.name);
  };

  /**
   * The day routine, the night routine, or both (owner, 2026-10-16): each step
   * of the brand's Routines tab filled by its criteria. Both: the day, then
   * the night without a product the day already has (its eye care, its cream
   * unless the range has a night one: « also in the day routine »).
   */
  function timed(f, c, range, { pinned = [], exclude = [] } = {}) {
    const time = c.time ?? 'day';
    const parts = time === 'both' ? ['day', 'night'] : [time];
    const skip = new Set(exclude);
    const wanted = pinned.map((id) => byId.get(id)).filter(Boolean);
    const steps = [];
    const skipped = [];
    const placed = [];
    const plan = [];
    const shown = new Set();
    let current = range;
    // A main concern's own steps (the eye routine), else the common ones.
    const stepsOf = f.routine_steps ?? routineSteps;
    for (const part of parts) {
      for (const step of stepsOf[part] ?? []) {
        const slot = `${part}_${step.order}`;
        const kind = KIND[step.types[0]] ?? step.types[0];
        plan.push({ slot, targets: step.concern_required ? 'primary' : null });
        let ranked;
        if (step.chosen_by.includes('product')) {
          ranked = [stepProduct(step, FIT.STEP_PRODUCT, skip, c)].filter(Boolean);
        } else {
          ranked = products.filter((x) => !skip.has(x.id) && timedEligible(x, step, part, f, c, current))
            .map((x) => ({ x, ...timedKey(x, step, part, f, c, current) }))
            .sort(byKey);
          if (!ranked.length && step.product) ranked = [stepProduct(step, FIT.STEP_FALLBACK, skip, c)].filter(Boolean);
        }
        // The product they came for takes its step when it may.
        const pin = wanted.find((x) => !shown.has(x.id) && !placed.some((p) => p.product_id === x.id) && ranked.some((r) => r.x.id === x.id));
        if (pin) {
          ranked.unshift(...ranked.splice(ranked.findIndex((r) => r.x.id === pin.id), 1));
          ranked[0].codes = [...ranked[0].codes, FIT.CUSTOMER_INTEREST];
          placed.push({ product_id: pin.id, handle: pin.handle, status: PINNED.PLACED });
        }
        if (!ranked.length) { skipped.push({ slot, kind, part, reason: SKIPPED.NO_ELIGIBLE_PRODUCT, optional: false }); continue; }
        const [top] = ranked;
        if (shown.has(top.x.id)) { skipped.push({ slot, kind, part, reason: SKIPPED.ALSO_IN_DAY_ROUTINE, product_id: top.x.id, handle: top.x.handle, type: top.x.k.functional_type, ...(top.x.k.ritual_stage ? { stage: top.x.k.ritual_stage } : {}), reason_codes: top.codes }); continue; }
        shown.add(top.x.id);
        // The serum's range is the routine's: the eye care and the cream follow it.
        if (step.chosen_by.includes('range') && top.x.k.range) current = top.x.k.range;
        steps.push({
          slot, kind, type: top.x.k.functional_type, part, optional: false,
          // Its ritual stage (Products tab « Étape du rituel »): the reply names the step by it (owner, 2026-10-17).
          ...(top.x.k.ritual_stage ? { stage: top.x.k.ritual_stage } : {}),
          product_id: top.x.id, handle: top.x.handle,
          alternatives: ranked.slice(1).filter((r) => !shown.has(r.x.id)).slice(0, 2).map((r) => ({ product_id: r.x.id, handle: r.x.handle })),
          reason_codes: top.codes,
          merchandised: null,
          ...(pin && top.x.id === pin.id ? { customer_interest: true } : {}),
          scores: { suitability: top.key.slice(1, -2).reduce((n, v) => n + v, 0), routine_fit: 0, total: top.key.slice(1, -2).reduce((n, v) => n + v, 0) },
        });
      }
    }
    for (const x of wanted) if (!placed.some((p) => p.product_id === x.id)) placed.push({ product_id: x.id, handle: x.handle, status: PINNED.NO_STEP });
    const budget = c.budgetMax ? withinBudget(steps, skipped, plan, c.budgetMax) : null;
    return { f, scope: time, steps, skipped, pinned: placed, c, budget, range: current };
  }

  /**
   * The morning and the evening, whole (owner, 2026-10-18: « it should also show the routine day and
   * the routine night even if they didnt select jour et nuit »). A « jour et nuit » build's night
   * leaves out what the day has; here it is put back, marked `also_in: 'day'`, so the evening shows
   * every step and which ones they already have.
   */
  function momentsOf(r) {
    const out = { day: [], night: [] };
    const shared = r.skipped.filter((k) => k.reason === SKIPPED.ALSO_IN_DAY_ROUTINE)
      .map((k) => ({ slot: k.slot, kind: k.kind, part: k.part, type: k.type, ...(k.stage ? { stage: k.stage } : {}), product_id: k.product_id, handle: k.handle, reason_codes: k.reason_codes ?? [], also_in: 'day' }));
    for (const s of [...r.steps, ...shared]) out[s.part]?.push(s);
    const order = (s) => Number(String(s.slot).split('_').pop()) || 0;
    for (const part of Object.keys(out)) out[part].sort((a, b) => order(a) - order(b));
    return out;
  }

  /**
   * The steps the routine cards tick at first (settings `preselected`, by the Routines tab's step
   * number; owner, 2026-10-19: the serum and the cream in the morning, the eye serum and the cream in
   * the evening). The others are marked `preselected: false`: shown, unticked, never added unasked.
   */
  function withPreselection(steps, key) {
    const rule = routines.preselected?.[key] ?? routines.preselected?.default;
    if (!rule || !Array.isArray(steps)) return steps;
    return steps.map((s) => (Array.isArray(rule[s.part]) && !rule[s.part].includes(Number(String(s.slot).split('_').pop())) ? { ...s, preselected: false } : s));
  }

  /** The routine's two moments: the chosen one as built, the other from a « jour et nuit » build of the same answers. */
  function bothMoments(result, profile, mode, history) {
    if (!routineSteps || !['day', 'night', 'both'].includes(result.scope)) return null;
    if (result.scope === 'both') return { chosen: 'both', ...momentsOf(result) };
    const both = evaluate(withAnswer(profile, 'routine_time', 'both'), mode, history);
    if (!both?.steps) return null;
    const all = momentsOf(both);
    const other = result.scope === 'day' ? 'night' : 'day';
    const mine = new Set(result.steps.map((s) => s.product_id));
    return {
      chosen: result.scope,
      [result.scope]: result.steps,
      // Its steps they already have from the chosen moment are marked, the rest would complete the routine.
      [other]: all[other].map(({ also_in: _a, ...s }) => (mine.has(s.product_id) ? { ...s, also_in: result.scope } : s)),
    };
  }

  const preselectedMoments = (m, key) => (m ? { ...m, day: withPreselection(m.day, key), night: withPreselection(m.night, key) } : undefined);
  /** The routine's steps as the cards tick them: a product ticked in a chosen moment (the evening's eye serum, « jour et nuit ») is ticked. */
  function preselectedSteps(steps, key, moments) {
    const marked = withPreselection(steps, key);
    const parts = !moments ? [] : moments.chosen === 'both' ? ['day', 'night'] : [moments.chosen];
    const ticked = new Set(parts.flatMap((part) => moments[part] ?? []).filter((s) => s.preselected !== false).map((s) => s.product_id));
    return marked.map(({ preselected, ...s }) => (preselected === false && !ticked.has(s.product_id) ? { ...s, preselected } : s));
  }

  const priceOf = (s) => byId.get(s.product_id)?.product.priceFrom ?? 0;
  const totalOf = (steps) => Math.round(steps.reduce((n, s) => n + priceOf(s), 0) * 100) / 100;

  /**
   * A ceiling: drop steps until the routine fits. Optional steps first, then
   * the required ones that are not the concern's step, from the last; the
   * concern's step goes last. Dropped steps are said (`over_budget`).
   */
  function withinBudget(steps, skipped, plan, max) {
    const dropped = [];
    const stepOf = (s) => plan.find((p) => (p.slot ?? (p.module ? `module_${p.module}` : `${p.type}_${p.order}`)) === s.slot);
    const rank = (s) => (s.optional ? 0 : stepOf(s)?.targets === 'primary' ? 2 : 1);
    while (steps.length && totalOf(steps) > max) {
      const victim = [...steps].sort((a, b) => rank(a) - rank(b) || steps.indexOf(b) - steps.indexOf(a))[0];
      steps.splice(steps.indexOf(victim), 1);
      skipped.push({ slot: victim.slot, kind: victim.kind, reason: SKIPPED.OVER_BUDGET, product_id: victim.product_id, handle: victim.handle });
      dropped.push(victim.slot);
    }
    return { max, total: totalOf(steps), dropped };
  }

  /**
   * « Trop cher » just after one product (owner, 2026-10-13; widened 2026-10-16).
   * In order, each cheaper than it by CHEAPER_RATIO at least and never premium
   * unless their concern justifies it (a premium cream €1.60 cheaper was offered
   * for « trop cher » on 2026-10-16):
   *   1. the same type, passing the same hard rules, for their main need;
   *   2. a coffret or kit for that need (owner: « it should be able to offer a kit »);
   *   3. the same type, suitable for them but not for that need: a generic one
   *      (owner: « if there are no options… suggest a generic one »), said as such.
   * Null when none: the treat comes instead.
   */
  function cheaperThan(previousId, profile) {
    const prev = byId.get(previousId);
    if (!prev || isBundle(prev.k)) return null;
    const c = read(profile);
    const choice = chooseFoundation(c);
    // The main need: theirs, else what the product they found too expensive was for.
    const need = c.primary ?? prev.k.primary_concern;
    const f = foundations.get(choice.key) ?? { key: 'cheaper', primary_concerns: [need], steps: [] };
    c.primary = need;
    const step = { type: prev.k.functional_type, targets: null };
    const ceiling = (prev.product.priceFrom ?? 0) * CHEAPER_RATIO;
    const cheaper = (x) => x.id !== prev.id && (x.product.priceFrom ?? Infinity) <= ceiling && (!x.k.premium || c.premium);
    const forNeed = (x) => [x.k.primary_concern, ...x.k.other_concerns].includes(need);
    const ranked = (pool, s) => pool.map((x) => ({ x, ...score(x, s, f, c, new Set()) })).sort((a, b) => b.s - a.s || a.x.product.priceFrom - b.x.product.priceFrom);
    const sameType = products.filter((x) => cheaper(x) && eligible(x, step, f, c, new Set()));
    const bundles = products.filter((x) => cheaper(x) && isBundle(x.k) && forNeed(x) && x.product.inStock && x.k.status !== 'do_not_advise'
      && (x.k.area ?? 'face') === (prev.k.area ?? 'face') && (!x.k.men || c.men) && !excluded(x, c));
    const [pool, code, type] = [
      [ranked(sameType.filter(forNeed), step), 'cheaper_alternative', step.type],
      [ranked(bundles, { type: 'kit' }), 'cheaper_bundle', 'kit'],
      [ranked(sameType.filter((x) => !forNeed(x)), step), 'cheaper_generic', step.type],
    ].find(([p]) => p.length) ?? [[]];
    if (!pool.length) return null;
    const [top, ...rest] = pool;
    return [{ slot: `${type}_cheaper`, kind: KIND[type] ?? type, type, optional: false, product_id: top.x.id, handle: top.x.handle, alternatives: rest.slice(0, 2).map((r) => ({ product_id: r.x.id, handle: r.x.handle })), reason_codes: [code, ...top.reasons], merchandised: null, scores: { suitability: top.s, routine_fit: 0, total: top.s } }];
  }

  /**
   * What may be a « petit plaisir »: the settings' treat types when set (owner, 2026-10-18: « only
   * mask, masque tissu and kits »), else the sheet's « Petit plaisir » column. Never an accessory or a
   * device (owner, 2026-10-29: the Gua Sha, « Petit plaisir » in the sheet, came for « under 40 »).
   */
  function isTreat(k) {
    if (NOT_ALONE.has(k.functional_type)) return false;
    const types = routines.treats?.types;
    return Array.isArray(types) && types.length ? types.includes(k.functional_type) : Boolean(k.treat);
  }

  /** A « petit plaisir » for their concern, instead of a routine (owner): within the ceiling when there is one. */
  function budgetTreat(c, max) {
    const ceiling = Math.min(routines.treats?.max_price ?? Infinity, max ?? Infinity);
    const fit = (x) => [x.k.primary_concern, ...x.k.other_concerns].filter((t) => c.concerns.includes(t)).length;
    const pool = products
      .filter((x) => isTreat(x.k) && x.product.inStock && x.k.status !== 'do_not_advise' && (!x.k.men || c.men) && x.product.priceFrom <= ceiling)
      .sort((a, b) => fit(b) - fit(a) || a.product.priceFrom - b.product.priceFrom || a.name.localeCompare(b.name));
    if (!pool.length) return null;
    const [top, ...rest] = pool;
    return [{ slot: 'treat', kind: KIND[top.k.functional_type] ?? top.k.functional_type, type: top.k.functional_type, optional: false, product_id: top.id, handle: top.handle, alternatives: rest.slice(0, 2).map((x) => ({ product_id: x.id, handle: x.handle })), reason_codes: ['budget_treat', ...(fit(top) ? [`${FIT.PRIMARY_CONCERN}:${[top.k.primary_concern, ...top.k.other_concerns].find((t) => c.concerns.includes(t))}`] : [])], merchandised: null, scores: { suitability: fit(top), routine_fit: 0, total: fit(top) } }];
  }

  /** § 3.4: a gift (gift sets first) or a spa evening (the treat routine). */
  function special(profile, request) {
    const c = read(profile);
    const fit = (x) => [x.k.primary_concern, ...x.k.other_concerns].filter((t) => c.concerns.includes(t)).length;
    const available = products.filter((x) => x.product.inStock && x.k.status !== 'do_not_advise' && (!x.k.men || c.men));
    if (request === 'gift') {
      const gifts = available.filter((x) => x.k.gift || isBundle(x.k)).sort((a, b) => fit(b) - fit(a) || isBundle(b.k) - isBundle(a.k) || a.product.priceFrom - b.product.priceFrom);
      if (!gifts.length) return null;
      return { key: 'gift', steps: [{ slot: 'gift', kind: 'kit', type: 'kit', optional: false, product_id: gifts[0].id, handle: gifts[0].handle, alternatives: gifts.slice(1, 3).map((x) => ({ product_id: x.id, handle: x.handle })), reason_codes: ['gift'], merchandised: null, scores: { suitability: fit(gifts[0]), routine_fit: 0, total: fit(gifts[0]) } }] };
    }
    const routine = (routines.treats?.treat_routines ?? []).find((r) => r.key === 'soiree_spa');
    if (!routine) return null;
    const steps = [];
    const used = new Set();
    for (const t of routine.types) {
      const [type, area] = t.split(':');
      // A spa evening is a treat: its mask is a sheet mask first, a cream mask otherwise.
      const fills = (k) => k.functional_type === type || (type === 'mask' && k.functional_type === 'sheet_mask');
      const pool = available.filter((x) => fills(x.k) && (x.k.area ?? 'face') === (area ?? 'face') && !used.has(x.id)).sort((a, b) => Boolean(b.k.treat) - Boolean(a.k.treat) || fit(b) - fit(a) || a.product.priceFrom - b.product.priceFrom);
      if (!pool.length) continue;
      used.add(pool[0].id);
      steps.push({ slot: `spa_${t.replace(':', '_')}`, kind: KIND[type] ?? type, type, optional: false, product_id: pool[0].id, handle: pool[0].handle, alternatives: pool.slice(1, 3).map((x) => ({ product_id: x.id, handle: x.handle })), reason_codes: ['spa'], merchandised: null, scores: { suitability: fit(pool[0]), routine_fit: 0, total: fit(pool[0]) } });
    }
    return steps.length ? { key: 'spa', steps, kit: routine.kit } : null;
  }

  const signature = (r) => (r?.steps ? `${r.f.key}|${r.steps.map((s) => s.product_id).join(',')}|${r.skipped.map((s) => s.slot).join(',')}` : r?.missing ? 'missing' : 'none');
  const withAnswer = (profile, field, value) => mergeProfile(profile, String(value).split('+').map((v) => ({ field, value: v, source: 'quick_choice', confidence: 'high' })), { allowed }).profile;

  /** A question's sentence (settings `questions.text`): a button answer gets the next question with no model call. */
  const withText = (q, locale) => {
    const text = fallbackChain(locale).map((lang) => questions.text?.[lang]?.[q.field]).find(Boolean);
    return text ? { ...q, text } : q;
  };

  function concernQuestion(locale, eyes = false) {
    // One button per main concern, in the shop's order: its `concern_buttons` value and label, else a
    // representative customer key for its first concern. The eyes asked about (owner's notes v4: « contour
    // des yeux », then « Rides » gave face products): the settings' `eye_concern_buttons`, eye concerns.
    const buttons = questions.concern_buttons ?? {};
    const valid = (value) => value && String(value).split('+').every((v) => allowed.primary_concern.includes(v));
    const eyeButtons = eyes && Array.isArray(questions.eye_concern_buttons) ? questions.eye_concern_buttons.filter((b) => valid(b?.value)) : [];
    const entries = eyeButtons.length ? eyeButtons.map((b) => ({ value: b.value, label: localized(b, locale) })) : routines.foundations.filter((f) => f.primary_concerns.length).map((f) => {
      const b = buttons[f.key] ?? {};
      const value = b.value ?? Object.entries(routines.concern_map ?? {}).find(([k, v]) => v === f.primary_concerns[0] && allowed.primary_concern.includes(k))?.[0];
      return valid(value) ? { value, label: localized(b, locale) } : null;
    }).filter(Boolean);
    const q = question('primary_concern', entries.map((e) => e.value), locale, 'missing');
    q.options = q.options.map((o, i) => (entries[i]?.label ? { ...o, label: entries[i].label } : o));
    return withText(q, locale);
  }

  function sizeQuestion(locale, profile, history) {
    const q = question('routine_scope', QUESTION_OPTIONS.routine_scope.filter((v) => allowed.routine_scope.includes(v)), locale, 'changes_recommendation');
    const labels = localized(sizeLabels, locale);
    if (labels?.length === q.options.length) q.options = q.options.map((o, i) => ({ ...o, label: labels[i] }));
    Object.assign(q, withText(q, locale));
    // Each size's price, from the products it would hold (plan § 3.3): the channel formats it.
    q.options = q.options.map((o) => {
      if (o.value === 'complete_existing') return o;
      const r = evaluate(withAnswer(profile, 'routine_scope', o.value), 'routine_builder', history);
      return r?.steps?.length ? { ...o, total: totalOf(r.steps) } : o;
    });
    return q;
  }

  /** The options of a question: the brand's age ranges and moments (Rules tab) when it has them. */
  function optionsFor(field) {
    if (field === 'age_band') return ageRanges.map((a) => a.key);
    if (field === 'routine_time' && routines.routine_times?.length) return routines.routine_times.map((t) => t.key);
    if (field === 'eye_concern') return questions.eye_concern?.options ?? [];
    // A sensitive skin is a skin type only in the day / night routine (owner, 2026-10-16); there, no
    // « Je ne sais pas » (owner, 2026-10-17).
    if (field === 'skin_type') return QUESTION_OPTIONS.skin_type.filter((v) => (routineSteps ? v !== 'unknown' : v !== 'sensitive'));
    return QUESTION_OPTIONS[field] ?? [];
  }

  /** A chip question; the age ranges and moments labelled by their Rules tab rows. No price on the moments (owner, 2026-10-17: the cards show them). */
  function chipQuestion(field, values, locale, profile, history) {
    const q = question(field, values, locale, 'changes_recommendation');
    const rows = field === 'age_band' ? ageRanges : field === 'routine_time' ? routines.routine_times ?? [] : [];
    const own = field === 'eye_concern' ? localized(questions.eye_concern?.labels, locale) ?? {} : {};
    q.options = q.options.map((o) => {
      const row = rows.find((r) => r.key === o.value);
      const rowLabel = row ? localized(row, locale, { prefix: 'label_' }) : null;
      return rowLabel ? { ...o, label: rowLabel } : own[o.value] ? { ...o, label: own[o.value] } : o;
    });
    return withText(q, locale);
  }

  /**
   * § 3.3: the next field in the brand's order (a main concern's own order: the eye routine's), never
   * sex. With `ask_all` (owner, 2026-10-17) every one is asked; otherwise only one whose answer would
   * change the routine.
   */
  function nextQuestion(profile, asked, history, locale, f) {
    const askAll = Boolean(routineSteps && questions.ask_all);
    for (const entry of f?.questions ?? questions.order ?? []) {
      const field = QUESTION_FIELDS[entry];
      // An age said in years (« j'ai 32 ans ») answers the age ranges.
      const known = field === 'age_band' ? Boolean(ageRangeOf(profile)) || isAnswered(profile, field) : isAnswered(profile, field);
      if (!field || field === 'primary_concern' || known || asked.includes(field)) continue;
      const values = optionsFor(field).filter((v) => v === 'unknown' || String(v).split('+').every((x) => allowed[field]?.includes(x)));
      if (!values.length) continue;
      const ask = () => (field === 'routine_scope' ? sizeQuestion(locale, profile, history) : chipQuestion(field, values, locale, profile, history));
      if (askAll) return ask();
      const outcomes = new Set(values.filter((v) => v !== 'unknown').map((v) => signature(evaluate(withAnswer(profile, field, v), 'routine_builder', history))));
      if (outcomes.size > 1) return ask();
    }
    return null;
  }

  const summary = (f, scope, range = f.preferred_range) => ({ key: f.key, route: null, scope, preferred_family: range ?? null, notes: [f.name_fr, f.rule, f.premium_when].filter(Boolean) });
  const base = (mode) => ({ mode, playbook: null, scope: null, area: null, steps: [], skipped: [], excluded: {}, considered: 0, next_question: null });

  return {
    /**
     * @param previous  the advice just given ({ product_ids }), passed only on the turn the customer
     *                  says the price is a problem: one product → a cheaper one of its type first
     */
    advise({ profile = {}, mode = 'conversation', asked = [], locale = 'fr', owned = [], ranges = [], pinned = [], previous = null } = {}) {
      // « Vous avez autre chose ? »: what was just shown is left out, so the next choices come.
      const exclude = previous?.more ? previous.shown ?? previous.product_ids ?? [] : [];
      const history = { owned, ranges: new Set(ranges), pinned, exclude };
      const request = valueOf(profile, 'request');
      if (request === 'gift' || request === 'spa') {
        const r = special(profile, request);
        if (!r) return { ...base(mode), status: STATUS.NO_MATCH, reason: NO_MATCH.NO_PRODUCT };
        return { ...base(mode), status: STATUS.RECOMMENDED, playbook: { key: r.key, route: null, scope: null, preferred_family: null, notes: [] }, scope: request, area: 'face', steps: r.steps, considered: r.steps.length };
      }
      // « Petit budget », « trop cher », no amount: a « petit plaisir » instead of a routine (owner).
      const budgetSaid = valueOf(profile, 'budget') === 'small' && !Number(valueOf(profile, 'budget_max'));
      if (budgetSaid && mode !== 'routine_builder' && previous?.product_ids?.length === 1) {
        const cheaper = cheaperThan(previous.product_ids[0], profile);
        if (cheaper) return { ...base(mode), status: STATUS.RECOMMENDED, playbook: { key: 'cheaper', route: null, scope: 'targeted', preferred_family: null, notes: ['the product was too expensive: the same type, cheaper, for the same need'] }, scope: 'targeted', area: 'face', steps: cheaper, considered: 1, total_price: totalOf(cheaper), cheaper_than: previous.product_ids[0] };
      }
      if (budgetSaid) {
        const treat = budgetTreat(read(profile), null);
        if (treat) return { ...base(mode), status: STATUS.RECOMMENDED, playbook: { key: 'treat', route: null, scope: 'targeted', preferred_family: null, notes: ['a small budget: a « petit plaisir » rather than a routine'] }, scope: 'targeted', area: 'face', steps: treat, considered: 1, total_price: totalOf(treat) };
      }
      const result = evaluate(profile, mode, history);
      if (result.none) return { ...base(mode), status: STATUS.NO_MATCH, reason: result.none };
      // The hands, lips, feet or body with no concern yet: no buttons (they are the face's), the model asks.
      if (result.areaMissing) return { ...base(mode), status: STATUS.NEEDS_INFO, reason: 'open_primary_concern', area: result.areaMissing };
      if (exclude.length && !result.missing && !result.steps?.length) return { ...base(mode), status: STATUS.NO_MATCH, reason: 'no_other_option', playbook: summary(result.f, result.scope) };
      if (result.missing) {
        const c = read(profile);
        if (asked.includes('primary_concern')) {
          // A type asked for, the concern still open: examples of it rather than nothing.
          const examples = mode !== 'routine_builder' && c.desired ? typeExamples(c) : null;
          if (examples) return { ...base(mode), status: STATUS.RECOMMENDED, playbook: { key: 'type_examples', route: null, scope: 'targeted', preferred_family: null, notes: ['examples of the type asked for, their concern still open'] }, scope: 'targeted', area: 'face', steps: examples.map((s) => ({ ...s, top_choices: true })), considered: 1, total_price: totalOf(examples) };
          return { ...base(mode), status: STATUS.NEEDS_INFO, reason: 'open_primary_concern' };
        }
        return { ...base(mode), status: STATUS.NEEDS_INFO, reason: 'missing', next_question: concernQuestion(locale, mode !== 'routine_builder' && c.area === 'eyes') };
      }
      if (mode === 'routine_builder' && asked.length < MAX_BUILDER_QUESTIONS + 2) {
        const q = nextQuestion(profile, asked, history, locale, result.f);
        if (q) return { ...base(mode), status: STATUS.NEEDS_INFO, reason: 'routine_builder', playbook: summary(result.f, null), next_question: q };
      }
      // A ceiling even the concern's step is over: a « petit plaisir » under it.
      if (result.budget && !result.steps.length) {
        const treat = budgetTreat(result.c, result.budget.max);
        if (treat) return { ...base(mode), status: STATUS.RECOMMENDED, playbook: { key: 'treat', route: null, scope: 'targeted', preferred_family: null, notes: ['the routine is over the budget: a « petit plaisir » within it'] }, scope: 'targeted', area: 'face', steps: treat, considered: 1, total_price: totalOf(treat), budget: { ...result.budget, total: totalOf(treat) } };
      }
      const moments = mode === 'routine_builder' && result.steps.length ? preselectedMoments(bothMoments(result, profile, mode, history), result.f.key) : undefined;
      return {
        ...base(mode),
        status: result.steps.length ? STATUS.RECOMMENDED : STATUS.NO_MATCH,
        ...(result.steps.length ? {} : { reason: NO_MATCH.NO_PRODUCT }),
        playbook: summary(result.f, result.scope, result.range),
        scope: result.scope,
        area: result.area ?? (result.f.key === 'eyes' ? 'eyes' : 'face'),
        // Nothing for the hands (lips): the face's product for the need, which the reply says (`area_fallback`).
        ...(result.areaFallback ? { area_fallback: result.areaFallback } : {}),
        // Outside the builder, one need: the best fit and its two alternatives are « our top choices ».
        steps: mode !== 'routine_builder' && result.scope === 'targeted' ? result.steps.map((s) => ({ ...s, top_choices: true })) : mode === 'routine_builder' ? preselectedSteps(result.steps, result.f.key, moments) : result.steps,
        skipped: result.skipped,
        considered: result.steps.length,
        total_price: totalOf(result.steps),
        ...(result.budget ? { budget: result.budget } : {}),
        ...(result.askedType ? { asked_type: result.askedType } : {}),
        ...(result.pinned.length ? { pinned: result.pinned } : {}),
        // Their age range, the brand's (a chip, or their age in years): kept with the routine.
        ...(result.c?.age ? { age_range: result.c.age } : {}),
        // The builder's routine: both moments, for the routine cards (never read to the model).
        ...(moments ? { moments } : {}),
      };
    },

    /**
     * One « petit plaisir » (§ 3.4): never with a small budget, never in the routine. It treats one of
     * their concerns and suits their skin (owner, 2026-10-17: an anti-blemish patch followed an
     * anti-age routine for dry skin); none fits, no treat.
     */
    treat({ profile = {}, exclude = [] } = {}) {
      const c = read(profile);
      // With a budget the advice already is the treat, or a routine cut to fit: nothing more.
      if (c.budget === 'small' || c.budgetMax) return null;
      const skip = new Set(exclude);
      const max = routines.treats?.max_price ?? Infinity;
      // The eye routine's other eye concern counts too.
      const concerns = [...new Set([...c.concerns, ...(c.eye && c.eye !== 'none' ? [concernOf(c.eye)] : [])])];
      const fit = (x) => [x.k.primary_concern, ...x.k.other_concerns].filter((t) => concerns.includes(t)).length;
      // Its area is the routine's: the eyes for the eye routine, the face or the eyes otherwise; never
      // the body (a body and hands coffret followed the eye routine).
      const choice = chooseFoundation(c);
      const areas = choice.key === 'eyes' || foundations.get(choice.key)?.area === 'eyes' ? ['eyes'] : ['face', 'eyes'];
      const pool = products.filter((x) => isTreat(x.k) && x.product.inStock && x.k.status !== 'do_not_advise' && !skip.has(x.id) && (!x.k.men || c.men) && x.product.priceFrom <= max
        && areas.includes(x.k.area ?? 'face')
        && fit(x) > 0 && !(c.skin && x.k.skin?.[c.skin] === 'unsuitable') && !(c.sensitive && x.k.sensitive === 'avoid') && !excluded(x, c));
      const skinFor = (x) => skinFit(x.k, c).score;
      const best = pool.sort((a, b) => fit(b) - fit(a) || skinFor(b) - skinFor(a) || a.product.priceFrom - b.product.priceFrom || a.name.localeCompare(b.name))[0];
      return best ? { product_id: best.id, handle: best.handle, reasons: [] } : null;
    },
  };
}

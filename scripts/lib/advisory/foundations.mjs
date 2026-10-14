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
 * Same advice shape as the playbook engine (recommend.mjs), which it replaces
 * for a shop that has routines and product knowledge (side by side, owner).
 * Channel-free: no prompt, no chip, no card.
 */

import { mergeProfile, valueOf, isAnswered } from './profile.mjs';
import { ingredientWords } from './ingredients.mjs';
import { hasPhrase, norm } from './text.mjs';
import { FIT, NO_MATCH, PINNED, SKIPPED, STATUS } from './reason-codes.mjs';
import { fillsStep, isBundle } from './product-knowledge.mjs';

const MAX_BUILDER_QUESTIONS = 4;
/** Profile current_routine kinds → product types. */
const OWNED_TYPE = { cleanser: 'cleanser', moisturiser: 'cream', night_cream: 'cream', serum: 'serum', lotion: 'lotion', mask: 'mask', eye_care: 'eye', booster: 'serum' };
/** The engine's desired care types → product types. */
const DESIRED_TYPE = { cleanser: 'cleanser', moisturiser: 'cream', night_cream: 'cream', serum: 'serum', lotion: 'lotion', mask: 'mask', eye_care: 'eye', booster: 'serum' };
/** The engine's step kinds per product type, for the conversation layer (Phase 2's « already owned » and its prompts). */
const KIND = { cleanser: 'cleanser', makeup_remover: 'cleanser', lotion: 'lotion', exfoliant: 'lotion', serum: 'serum', cream: 'moisturiser', spf: 'spf', eye: 'eye_care', mask: 'mask', kit: 'kit' };
const QUESTION_FIELDS = { concern: 'primary_concern', skin_type: 'skin_type', sensitivity: 'sensitivity', current_routine: 'current_routine', size: 'routine_scope' };
const QUESTION_OPTIONS = {
  skin_type: ['dry', 'normal', 'combination', 'oily', 'unknown'],
  sensitivity: ['sensitive', 'none'],
  current_routine: ['none', 'moisturiser', 'cleanser+moisturiser', 'cleanser+serum+moisturiser'],
  routine_scope: ['essential', 'complete', 'spa', 'complete_existing'],
};
const OPPOSITE_TEXTURE = { rich: 'light', light: 'rich' };

export const WEIGHTS = {
  primary: 1, primaryAmongOthers: 0.6, foundationConcern: 0.4, secondary: 0.3, secondaryCap: 0.6,
  skinIdeal: 0.3, skinSuitable: 0.1, texture: 0.3, textureMismatch: -0.3, preferredRange: 0.4, premiumRange: 0.6,
  caution: -0.2, unjustifiedPremium: -1, men: 0.8, customerRange: 0.15,
  /** With a budget, a product this close to the best fit and cheaper takes its place. */
  budgetWindow: 0.15,
};

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
  const eyeConcerns = new Set(routines.eye_concerns ?? []);
  const sizeLabels = routines.questions?.chips?.size ?? {};

  /** What the customer's profile says, in the brand's terms. */
  function read(profile) {
    const primaryRaw = valueOf(profile, 'primary_concern');
    const secondaryRaw = valueOf(profile, 'secondary_concerns') ?? [];
    const behaviours = valueOf(profile, 'skin_behaviour') ?? [];
    const raw = [primaryRaw, ...secondaryRaw, ...behaviours].filter(Boolean);
    const all = [...new Set(raw.map(concernOf))];
    const skin = valueOf(profile, 'skin_type');
    return {
      primaryChosen: profile.primary_concern?.source === 'quick_choice' ? concernOf(primaryRaw) : null,
      primary: primaryRaw ? concernOf(primaryRaw) : null,
      concerns: all,
      premium: raw.some((c) => (routines.premium_concerns ?? []).includes(c)),
      skin: skin === 'very_dry' ? 'dry' : skin,
      sensitive: ['sensitive', 'reactive'].includes(valueOf(profile, 'sensitivity')),
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
    if (c.request === 'basic_routine') return { key: 'G' };
    if (c.area === 'body') return { none: NO_MATCH.AREA_NOT_COVERED };
    const face = c.concerns.filter((x) => !eyeConcerns.has(x));
    const eyes = c.concerns.filter((x) => eyeConcerns.has(x));
    if (!face.length && (eyes.length || c.area === 'eyes')) return eyes.length ? { key: 'eyes' } : { missing: true };
    if (c.primaryChosen && !eyeConcerns.has(c.primaryChosen)) {
      const f = routines.foundations.find((x) => x.primary_concerns.includes(c.primaryChosen));
      if (f) return { key: f.key };
    }
    const votes = new Map();
    for (const concern of face) for (const f of routines.foundations) if (f.primary_concerns.includes(concern)) votes.set(f.key, (votes.get(f.key) ?? 0) + 1);
    // A dry skin is Hydration only when nothing else is the main need.
    if (!votes.size && c.skin === 'dry') return { key: 'A', impliedConcern: 'dryness' };
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
      return [f.steps.find((s) => s.targets === 'primary') ?? f.steps[0]];
    }
    if (scope === 'essential') return daily.filter((s) => s.required);
    const complete = [...daily, ...modules];
    return scope === 'spa' ? [...complete, ...f.steps.filter((s) => s.frequency === 'occasional')] : complete;
  }

  function eligible(x, step, f, c, used) {
    const k = x.k;
    if (used.has(x.id) || k.status === 'do_not_advise' || !x.product.inStock) return false;
    if (!fillsStep(k, step.type) || isBundle(k)) return false;
    if ((step.type === 'eye' ? 'eyes' : 'face') !== (k.area ?? 'face')) return false;
    if (k.men && !c.men) return false;
    if (c.skin && k.skin?.[c.skin] === 'unsuitable') return false;
    if ((c.sensitive || f.tolerance_first) && k.sensitive === 'avoid') return false;
    const text = norm(`${x.name} ${x.product.keyIngredients ?? ''} ${x.product.description ?? ''} ${(k.contains ?? []).join(' ')}`);
    if (c.exclusions.some((e) => ingredientWords(e).some((w) => hasPhrase(text, w)))) return false;
    const targets = [k.primary_concern, ...k.other_concerns];
    if (step.targets === 'primary' && f.primary_concerns.length && !targets.some((t) => f.primary_concerns.includes(t) || t === c.primary)) return false;
    if (step.targets === 'module' && !targets.some((t) => step.when.includes(t))) return false;
    return true;
  }

  function score(x, step, f, c, ranges) {
    const k = x.k;
    const reasons = [];
    let s = 0;
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
    if (c.sensitive && k.sensitive === 'suitable') reasons.push(FIT.SENSITIVE_SKIN_MATCH);
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
  function evaluate(profile, mode, { owned = [], ranges = new Set(), pinned = [], exclude = [] } = {}) {
    const c = read(profile);
    const choice = chooseFoundation(c);
    if (choice.none) return { none: choice.none };
    if (choice.missing) return { missing: true };
    if (choice.impliedConcern && !c.primary) { c.primary = choice.impliedConcern; c.concerns = [...c.concerns, choice.impliedConcern]; }

    const f = choice.key === 'eyes'
      ? { key: 'eyes', name_fr: 'Yeux', primary_concerns: c.concerns.filter((x) => eyeConcerns.has(x)), steps: [{ order: 1, type: 'eye', frequency: 'daily', required: true, targets: 'primary' }] }
      : foundations.get(choice.key);
    if (choice.key === 'eyes' && !eyeConcerns.has(c.primary)) c.primary = f.primary_concerns[0];
    let scope = valueOf(profile, 'routine_scope') ?? (mode === 'routine_builder' ? 'essential' : 'targeted');
    if (scope === 'complete_existing') scope = 'complete';
    if (c.budget === 'small' && scope !== 'targeted') scope = 'essential';
    if (choice.key === 'eyes' && scope !== 'targeted' && mode !== 'routine_builder') scope = 'targeted';

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
      const pool = products.filter((x) => eligible(x, step, f, c, used));
      // A man: his range first among the suitable products (owner: « ranked first, others still
      // possible »); a sensitive-skin cleanser outscored the men's one in the customer batch.
      const menFirst = (x) => (c.men && x.k.men ? 1 : 0);
      const ranked = pool.map((x) => ({ x, ...score(x, step, f, c, ranges) }))
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
    for (const x of wanted) if (!placed.some((p) => p.product_id === x.id)) placed.push({ product_id: x.id, handle: x.handle, status: PINNED.NO_STEP });
    const budget = c.budgetMax ? withinBudget(steps, skipped, plan, c.budgetMax) : null;
    // OUR TOP CHOICES for one need, outside the builder (owner): the best product
    // of each type that targets it, not three of one type. A type they asked
    // for (« juste un sérum ») keeps its own alternatives.
    if (scope === 'targeted' && mode !== 'routine_builder' && !c.desired && steps.length === 1 && choice.key !== 'eyes') {
      const others = f.steps
        // A cleanser is a top choice only where the foundation says it treats the need (Imperfections).
        .filter((s) => s.frequency === 'daily' && s.type !== steps[0].type && !c.owned.includes(s.type) && (s.type !== 'cleanser' || s.targets === 'primary'))
        .map((s) => products.filter((x) => eligible(x, { ...s, targets: 'primary' }, f, c, used)).map((x) => ({ x, ...score(x, s, f, c, ranges) })).filter((r) => [r.x.k.primary_concern, ...r.x.k.other_concerns].includes(c.primary))
          .sort((a, b) => b.s - a.s || a.x.product.priceFrom - b.x.product.priceFrom)[0])
        .filter(Boolean)
        .sort((a, b) => b.s - a.s)
        .slice(0, 2);
      if (others.length) steps[0] = { ...steps[0], alternatives: others.map((r) => ({ product_id: r.x.id, handle: r.x.handle })) };
    }
    return { f, scope, steps, skipped, pinned: placed, c, budget };
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
    const stepOf = (s) => plan.find((p) => (p.module ? `module_${p.module}` : `${p.type}_${p.order}`) === s.slot);
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
   * « Trop cher » just after one product (owner): the cheapest product of the
   * same type, cheaper than it, that passes the same hard rules and still
   * targets their concern (or the concerns that product targeted). Null when
   * there is none: the treat comes instead.
   */
  function cheaperThan(previousId, profile) {
    const prev = byId.get(previousId);
    if (!prev || isBundle(prev.k)) return null;
    const c = read(profile);
    const choice = chooseFoundation(c);
    // The main need: theirs, else what the product they found too expensive was for.
    const need = c.primary ?? prev.k.primary_concern;
    const concerns = c.concerns.length ? c.concerns : [need];
    const f = foundations.get(choice.key) ?? { key: 'cheaper', primary_concerns: [need], steps: [] };
    c.primary = need;
    const step = { type: prev.k.functional_type, targets: null };
    const pool = products
      .filter((x) => x.id !== prev.id && eligible(x, step, f, c, new Set()) && (x.product.priceFrom ?? Infinity) < (prev.product.priceFrom ?? 0))
      .filter((x) => [x.k.primary_concern, ...x.k.other_concerns].includes(need))
      .map((x) => ({ x, ...score(x, step, f, c, new Set()) }))
      .sort((a, b) => b.s - a.s || a.x.product.priceFrom - b.x.product.priceFrom);
    if (!pool.length) return null;
    const [top, ...rest] = pool;
    return [{ slot: `${step.type}_cheaper`, kind: KIND[step.type] ?? step.type, type: step.type, optional: false, product_id: top.x.id, handle: top.x.handle, alternatives: rest.slice(0, 2).map((r) => ({ product_id: r.x.id, handle: r.x.handle })), reason_codes: ['cheaper_alternative', ...top.reasons], merchandised: null, scores: { suitability: top.s, routine_fit: 0, total: top.s } }];
  }

  /** A « petit plaisir » for their concern, instead of a routine (owner): within the ceiling when there is one. */
  function budgetTreat(c, max) {
    const ceiling = Math.min(routines.treats?.max_price ?? Infinity, max ?? Infinity);
    const fit = (x) => [x.k.primary_concern, ...x.k.other_concerns].filter((t) => c.concerns.includes(t)).length;
    const pool = products
      .filter((x) => x.k.treat && x.product.inStock && x.k.status !== 'do_not_advise' && (!x.k.men || c.men) && x.product.priceFrom <= ceiling)
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
      const pool = available.filter((x) => x.k.functional_type === type && (x.k.area ?? 'face') === (area ?? 'face') && !used.has(x.id)).sort((a, b) => fit(b) - fit(a) || a.product.priceFrom - b.product.priceFrom);
      if (!pool.length) continue;
      used.add(pool[0].id);
      steps.push({ slot: `spa_${t.replace(':', '_')}`, kind: KIND[type] ?? type, type, optional: false, product_id: pool[0].id, handle: pool[0].handle, alternatives: pool.slice(1, 3).map((x) => ({ product_id: x.id, handle: x.handle })), reason_codes: ['spa'], merchandised: null, scores: { suitability: fit(pool[0]), routine_fit: 0, total: fit(pool[0]) } });
    }
    return steps.length ? { key: 'spa', steps, kit: routine.kit } : null;
  }

  const signature = (r) => (r?.steps ? `${r.f.key}|${r.steps.map((s) => s.product_id).join(',')}|${r.skipped.map((s) => s.slot).join(',')}` : r?.missing ? 'missing' : 'none');
  const withAnswer = (profile, field, value) => mergeProfile(profile, String(value).split('+').map((v) => ({ field, value: v, source: 'quick_choice', confidence: 'high' })), { allowed }).profile;

  function concernQuestion(locale) {
    // One representative customer key per foundation's first concern, in the shop's order.
    const values = routines.foundations.filter((f) => f.primary_concerns.length).map((f) => Object.entries(routines.concern_map ?? {}).find(([k, v]) => v === f.primary_concerns[0] && allowed.primary_concern.includes(k))?.[0]).filter(Boolean);
    return question('primary_concern', values, locale, 'missing');
  }

  function sizeQuestion(locale, profile, history) {
    const q = question('routine_scope', QUESTION_OPTIONS.routine_scope.filter((v) => allowed.routine_scope.includes(v)), locale, 'changes_recommendation');
    const labels = sizeLabels[String(locale).slice(0, 2)] ?? sizeLabels.fr;
    if (labels?.length === q.options.length) q.options = q.options.map((o, i) => ({ ...o, label: labels[i] }));
    // Each size's price, from the products it would hold (plan § 3.3): the channel formats it.
    q.options = q.options.map((o) => {
      if (o.value === 'complete_existing') return o;
      const r = evaluate(withAnswer(profile, 'routine_scope', o.value), 'routine_builder', history);
      return r?.steps?.length ? { ...o, total: totalOf(r.steps) } : o;
    });
    return q;
  }

  /** § 3.3: the next field whose answer would change the routine, in the brand's order; never age or sex. */
  function nextQuestion(profile, asked, history, locale) {
    for (const entry of routines.questions?.order ?? []) {
      const field = QUESTION_FIELDS[entry];
      if (!field || field === 'primary_concern' || isAnswered(profile, field) || asked.includes(field)) continue;
      const values = (QUESTION_OPTIONS[field] ?? []).filter((v) => v === 'unknown' || String(v).split('+').every((x) => allowed[field]?.includes(x)));
      const outcomes = new Set(values.filter((v) => v !== 'unknown').map((v) => signature(evaluate(withAnswer(profile, field, v), 'routine_builder', history))));
      if (outcomes.size > 1) return field === 'routine_scope' ? sizeQuestion(locale, profile, history) : question(field, values, locale, 'changes_recommendation');
    }
    return null;
  }

  const summary = (f, scope) => ({ key: f.key, route: null, scope, preferred_family: f.preferred_range ?? null, notes: [f.name_fr, f.rule, f.premium_when].filter(Boolean) });
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
      if (exclude.length && !result.missing && !result.steps?.length) return { ...base(mode), status: STATUS.NO_MATCH, reason: 'no_other_option', playbook: summary(result.f, result.scope) };
      if (result.missing) {
        if (asked.includes('primary_concern')) return { ...base(mode), status: STATUS.NEEDS_INFO, reason: 'open_primary_concern' };
        return { ...base(mode), status: STATUS.NEEDS_INFO, reason: 'missing', next_question: concernQuestion(locale) };
      }
      if (mode === 'routine_builder' && asked.length < MAX_BUILDER_QUESTIONS + 2) {
        const q = nextQuestion(profile, asked, history, locale);
        if (q) return { ...base(mode), status: STATUS.NEEDS_INFO, reason: 'routine_builder', playbook: summary(result.f, null), next_question: q };
      }
      // A ceiling even the concern's step is over: a « petit plaisir » under it.
      if (result.budget && !result.steps.length) {
        const treat = budgetTreat(result.c, result.budget.max);
        if (treat) return { ...base(mode), status: STATUS.RECOMMENDED, playbook: { key: 'treat', route: null, scope: 'targeted', preferred_family: null, notes: ['the routine is over the budget: a « petit plaisir » within it'] }, scope: 'targeted', area: 'face', steps: treat, considered: 1, total_price: totalOf(treat), budget: { ...result.budget, total: totalOf(treat) } };
      }
      return {
        ...base(mode),
        status: result.steps.length ? STATUS.RECOMMENDED : STATUS.NO_MATCH,
        ...(result.steps.length ? {} : { reason: NO_MATCH.NO_PRODUCT }),
        playbook: summary(result.f, result.scope),
        scope: result.scope,
        area: result.f.key === 'eyes' ? 'eyes' : 'face',
        // Outside the builder, one need: the best fit and its two alternatives are « our top choices ».
        steps: mode !== 'routine_builder' && result.scope === 'targeted' ? result.steps.map((s) => ({ ...s, top_choices: true })) : result.steps,
        skipped: result.skipped,
        considered: result.steps.length,
        total_price: totalOf(result.steps),
        ...(result.budget ? { budget: result.budget } : {}),
        ...(result.pinned.length ? { pinned: result.pinned } : {}),
      };
    },

    /** One « petit plaisir » (§ 3.4): never with a small budget, never in the routine. */
    treat({ profile = {}, exclude = [] } = {}) {
      const c = read(profile);
      // With a budget the advice already is the treat, or a routine cut to fit: nothing more.
      if (c.budget === 'small' || c.budgetMax) return null;
      const skip = new Set(exclude);
      const max = routines.treats?.max_price ?? Infinity;
      const pool = products.filter((x) => x.k.treat && x.product.inStock && x.k.status !== 'do_not_advise' && !skip.has(x.id) && (!x.k.men || c.men) && x.product.priceFrom <= max);
      const fit = (x) => [x.k.primary_concern, ...x.k.other_concerns].filter((t) => c.concerns.includes(t)).length;
      const best = pool.sort((a, b) => fit(b) - fit(a) || a.product.priceFrom - b.product.priceFrom || a.name.localeCompare(b.name))[0];
      return best ? { product_id: best.id, handle: best.handle, reasons: [] } : null;
    },
  };
}

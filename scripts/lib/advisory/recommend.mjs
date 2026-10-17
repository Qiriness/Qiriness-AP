/**
 * The advisory engine: profile in, recommendation (or the one question that
 * would change it) out. Pure and deterministic — the same profile, config and
 * catalogue always give the same answer — so every rule is a unit test.
 *
 *   profile
 *     → selectPlaybook        gates: area, primary concern; ambiguity → a question
 *     → slots for the scope   minus what the current routine already covers, and
 *                             minus the steps a product they still use fills
 *     → rankSlot per step     eligibility → suitability → routine fit → merchandising
 *     → next question?        routine builder only: the highest-priority unanswered
 *                             field whose answer would CHANGE the result
 *
 * CHANNEL-FREE: no prompt, no chip, no card. The storefront turns `next_question`
 * into buttons; an email draft would turn it into a sentence.
 */

import { allowedValues, isAnswered, mergeProfile, valueOf } from './profile.mjs';
import { compileConfig, inSlot, productSignals } from './config.mjs';
import { selectPlaybook } from './select-playbook.mjs';
import { exclusionOf, rankSlot, suitability, wantedTexture } from './ranking.mjs';
import { EXCLUSION, FIT, NO_MATCH, PINNED, SKIPPED, STATUS } from './reason-codes.mjs';
import { createFoundationAdvisor } from './foundations.mjs';
import { isBundle } from './product-knowledge.mjs';

/** Questions the routine builder may ask beyond the gates, at most. */
export const MAX_BUILDER_QUESTIONS = 4;
const MAX_OPTIONS = 8;

/** selection_priority entries → the profile field a chip question can fill. Sex is never asked. */
const PRIORITY_FIELD = {
  skin_type_and_behaviour: 'skin_type',
  sensitivity: 'sensitivity',
  current_routine: 'current_routine',
  requested_product_or_routine_scope: 'routine_scope',
  age: 'age_band'
};
const QUESTION_OPTIONS = {
  skin_type: ['dry', 'normal', 'combination', 'oily', 'unknown'],
  sensitivity: ['sensitive', 'none'],
  current_routine: ['none', 'moisturiser', 'cleanser+moisturiser', 'cleanser+serum+moisturiser'],
  routine_scope: ['targeted', 'essential', 'complete', 'complete_existing'],
  age_band: ['under_30', '30_44', '45_59', '60_plus']
};
const LABEL_GROUP = { primary_concern: 'concern', secondary_concerns: 'concern' };

/**
 * @param {object} rawConfig  the shop's config (data/advisor/<brand>.json or the advisor tables)
 * @param {{ products: object[] }} catalogue
 * @param {{ knowledge?: Map<string, object> | null, routines?: object | null }} [options]
 *   knowledge: product knowledge by handle (product-knowledge.mjs); routines: the brand's
 *   foundations (plan § 3.1–3.4). With both, advise() and treat() are the foundation
 *   engine's (foundations.mjs); without, the playbooks below (side by side, owner 2026-10-13).
 */
export function createAdvisor(rawConfig, catalogue, { knowledge = null, routines = null } = {}) {
  const compiled = compileConfig(rawConfig);
  const raw = compiled.raw;
  const signals = catalogue.products.map((p) => ({ ...productSignals(p, raw), knowledge: knowledge?.get(p.handle) ?? null }));
  const byId = new Map(signals.map((s) => [s.id, s]));
  const byHandle = new Map(signals.map((s) => [s.handle, s]));

  /** Products the customer still uses, a coffret or kit standing for what it contains. */
  function ownedSignals(ids) {
    const out = [];
    for (const id of ids ?? []) {
      const sig = byId.get(id);
      if (!sig) continue;
      const contents = isBundle(sig.knowledge) ? sig.knowledge.kit_contents : [];
      for (const s of contents.length ? contents.map((h) => byHandle.get(h)).filter(Boolean) : [sig]) if (!out.includes(s)) out.push(s);
    }
    return out;
  }

  /**
   * Does this owned product fill this step? By the brand's functional type and
   * area when its knowledge says; by the step's own catalogue rules otherwise.
   */
  function fills(sig, spec, area) {
    const k = sig.knowledge;
    const areaOk = k?.area ? k.area === area : sig.areas.has(area);
    if (!areaOk) return false;
    if (k?.functional_type) return (raw.functional_types?.[k.functional_type] ?? []).includes(spec.kind);
    return inSlot(sig, spec);
  }
  const allowed = allowedValues(compiled.vocabulary);

  function label(field, value, locale) {
    const group = LABEL_GROUP[field] ?? field;
    const pick = (lang) => raw.labels?.[lang]?.[group]?.[value];
    return pick(locale) ?? pick('fr') ?? value.replace(/_/g, ' ');
  }
  const question = (field, values, locale, reason) => ({
    field,
    reason,
    options: values.slice(0, MAX_OPTIONS).map((value) => ({ value, label: label(field, value, locale) }))
  });

  /** One routine for a selected playbook. */
  function evaluate(profile, selection, mode, now, { owned = [], ranges = new Set(), pinned = [] } = {}) {
    const { playbook, route } = selection;
    const area = valueOf(profile, 'body_area') ?? selection.inferredArea ?? playbook.area;
    const men = valueOf(profile, 'sex_target') === 'men';
    const scope = valueOf(profile, 'routine_scope') ?? (mode === 'routine_builder' ? 'essential' : 'targeted');
    const desired = valueOf(profile, 'desired_care_type');
    const current = (valueOf(profile, 'current_routine') ?? []).filter((k) => k !== 'none');
    const texturesRules = route?.texture ?? playbook.texture ?? null;
    const exclusions = valueOf(profile, 'known_exclusions') ?? [];
    const specOf = (key) => (men ? raw.slot_overrides?.men?.[key] : null) ?? raw.slots[key];

    let slots = slotList(playbook, route, scope);
    let single = scope === 'targeted';
    // A playbook without targeted priority slots: the one step whose best
    // product fits the customer best, out of the whole routine.
    let bestOfAll = false;
    if (single && !route && !playbook.targeted?.priority_slots) {
      slots = slotList(playbook, route, 'complete');
      bestOfAll = true;
      single = false;
    }
    if (desired) {
      const all = slotList(playbook, route, 'complete');
      const match = [...new Set([...slots.map((s) => s.key), ...all.map((s) => s.key)])].filter((k) => specOf(k)?.kind === desired);
      const generic = Object.keys(raw.slots).find((k) => raw.slots[k].kind === desired);
      slots = (match.length ? match : generic ? [generic] : []).map((key) => ({ key, optional: false }));
      single = true;
    }

    const steps = [];
    const skipped = [];
    const excluded = {};
    const used = new Set();
    // Each product they still use fills one step at most: one cream is not a day and a night cream.
    const mine = ownedSignals(owned);
    for (const s of mine) used.add(s.id);
    // The product the routine is built around: its step, added from the full
    // routine when the chosen size has none (an eye cream in an essential routine).
    const placed = [];
    const pinnedAt = new Map();
    for (const sig of (pinned ?? []).map((id) => byId.get(id)).filter((s) => s && !used.has(s.id))) {
      const fits = (list) => list.find((s) => !pinnedAt.has(s.key) && specOf(s.key) && fills(sig, specOf(s.key), specOf(s.key).area ?? area));
      let slot = fits(slots);
      if (!slot) {
        slot = fits(slotList(playbook, route, 'complete'));
        if (slot) slots = [...slots, { ...slot, optional: false }];
      }
      if (slot) pinnedAt.set(slot.key, sig);
      else placed.push({ product_id: sig.id, handle: sig.handle, status: PINNED.NO_STEP });
    }
    // One product asked for: the one they came for, when it suits.
    if ((single || bestOfAll) && pinnedAt.size) slots = [...slots.filter((s) => pinnedAt.has(s.key)), ...slots.filter((s) => !pinnedAt.has(s.key))];
    let considered = 0;
    for (const slot of slots) {
      const { key } = slot;
      const spec = specOf(key);
      if (!spec) continue;
      const optional = slot.optional || spec.optional === true;
      // Routine completion (rule 9): a step the customer already covers is kept
      // as theirs, unless that is exactly the step they asked for.
      if (current.includes(spec.kind) && spec.kind !== desired) {
        skipped.push({ slot: key, kind: spec.kind, reason: SKIPPED.ALREADY_IN_ROUTINE });
        continue;
      }
      // Phase 2: a product they still use counts toward the routine and is never replaced.
      const theirs = spec.kind !== desired ? mine.find((s) => fills(s, spec, spec.area ?? area)) : null;
      if (theirs) {
        mine.splice(mine.indexOf(theirs), 1);
        skipped.push({ slot: key, kind: spec.kind, reason: SKIPPED.ALREADY_OWNED, product_id: theirs.id, handle: theirs.handle });
        continue;
      }
      const r = rankSlot({
        slotKey: key,
        spec,
        signals,
        profile,
        raw,
        merchandising: compiled.merchandising,
        family: playbook.preferred_family ?? null,
        texture: wantedTexture(texturesRules, spec, profile, raw),
        // An eye step inside a face routine takes eye products (rule 3 holds per step).
        eligibility: { area: spec.area ?? area, men, exclusions, wantsBundle: false },
        used,
        toleranceFirst: playbook.tolerance_first === true,
        now,
        ranges,
        include: pinnedAt.has(key) ? new Set([pinnedAt.get(key).id]) : new Set()
      });
      const wanted = pinnedAt.get(key);
      if (wanted) {
        const at = r.ranked.findIndex((x) => x.id === wanted.id);
        if (at > 0) r.ranked.unshift(...r.ranked.splice(at, 1));
        if (at >= 0) r.ranked[0].reasons = [...r.ranked[0].reasons, FIT.CUSTOMER_INTEREST];
        const why = r.rejected[wanted.id];
        placed.push({ product_id: wanted.id, handle: wanted.handle, status: at >= 0 ? PINNED.PLACED : why === EXCLUSION.UNSUITABLE ? PINNED.UNSUITABLE : PINNED.UNAVAILABLE, ...(at < 0 && why ? { reason: why } : {}) });
      }
      for (const [code, n] of Object.entries(r.excluded)) excluded[code] = (excluded[code] ?? 0) + n;
      considered += r.ranked.length;
      if (!r.ranked.length) {
        skipped.push({ slot: key, kind: spec.kind, reason: SKIPPED.NO_ELIGIBLE_PRODUCT, optional });
        continue;
      }
      const [top, ...rest] = r.ranked;
      used.add(top.id);
      steps.push({
        slot: key,
        kind: spec.kind,
        optional,
        product_id: top.id,
        handle: top.handle,
        alternatives: rest.slice(0, 2).map((x) => ({ product_id: x.id, handle: x.handle })),
        reason_codes: [...top.reasons, ...(r.preferredUnavailable ? [FIT.PREFERRED_UNAVAILABLE] : [])],
        merchandised: top.merch?.tier ?? null,
        ...(wanted && top.id === wanted.id ? { customer_interest: true } : {}),
        scores: { suitability: top.suitability, routine_fit: top.routineFit, total: top.total }
      });
      if (single) break;
    }
    // One targeted product: the steps passed over on the way are not news to the customer.
    if (single && steps.length) return { playbook, route, scope, area, steps, skipped: [], excluded, considered, pinned: placed };
    if (bestOfAll && steps.length > 1) {
      const best = steps.find((s) => s.customer_interest) ?? steps.reduce((a, b) => (b.scores.suitability > a.scores.suitability ? b : a));
      return { playbook, route, scope, area, steps: [best], skipped: [], excluded, considered, pinned: placed };
    }
    return { playbook, route, scope, area, steps, skipped, excluded, considered, pinned: placed };
  }

  const signature = (result) => result
    ? `${result.playbook.key}|${result.route?.key ?? ''}|${result.steps.map((s) => s.product_id).join(',')}|${result.skipped.map((s) => s.slot).join(',')}`
    : 'none';

  /** The profile with one answer applied, as a chip would apply it. */
  function withAnswer(profile, field, value) {
    const updates = String(value).split('+').map((v) => ({ field, value: v, source: 'quick_choice', confidence: 'high' }));
    return mergeProfile(profile, updates, { allowed }).profile;
  }

  /** Routine builder: the next field whose answer would change the routine, in the shop's priority order. */
  function materialQuestion(profile, asked, mode, now, locale, history) {
    for (const entry of raw.selection_priority ?? []) {
      const field = PRIORITY_FIELD[entry];
      if (!field || isAnswered(profile, field) || asked.includes(field)) continue;
      const values = QUESTION_OPTIONS[field].filter((v) => v === 'unknown' || String(v).split('+').every((x) => allowed[field].includes(x)));
      const outcomes = new Set();
      for (const v of values.filter((x) => x !== 'unknown')) {
        const p = withAnswer(profile, field, v);
        const sel = selectPlaybook(p, raw);
        outcomes.add(sel.status === 'selected' ? signature(evaluate(p, sel, mode, now, history)) : sel.status);
      }
      if (outcomes.size > 1) return question(field, values, locale, 'changes_recommendation');
    }
    return null;
  }

  const playbookAdvisor = {
    config: compiled,
    allowed,
    signals,
    label,
    /**
     * @param {{ profile: object, mode?: 'conversation' | 'routine_builder', asked?: string[], locale?: string, now?: Date,
     *   owned?: string[], ranges?: string[], pinned?: string[] }} input
     *   owned: product ids the customer said they still use; ranges: knowledge ranges they use (a ranking nudge);
     *   pinned: products to build the routine around (their interest), each placed in its step when it suits
     */
    advise({ profile = {}, mode = 'conversation', asked = [], locale = 'fr', now = new Date(), owned = [], ranges = [], pinned = [] } = {}) {
      const history = { owned, ranges: new Set(ranges), pinned };
      let selection = selectPlaybook(profile, raw);
      const base = { mode, playbook: null, scope: null, area: null, steps: [], skipped: [], excluded: {}, considered: 0, next_question: null };

      if (selection.status === 'no_match') return { ...base, status: STATUS.NO_MATCH, reason: selection.reason };
      if (selection.status === 'missing' || selection.status === 'ambiguous') {
        // Asked once already and still open (« je ne sais pas »): an ambiguous
        // pair falls back to the first candidate in the shop's order rather
        // than asking again; a missing concern is asked openly by the model.
        if (asked.includes(selection.field)) {
          if (selection.status === 'ambiguous' && selection.field === 'primary_concern') {
            const playbook = raw.playbooks.find((p) => p.key === selection.candidates[0]);
            selection = { status: 'selected', playbook, route: null, inferredArea: null, defaulted: true };
          } else {
            return { ...base, status: STATUS.NEEDS_INFO, reason: `open_${selection.field}` };
          }
        } else {
          return { ...base, status: STATUS.NEEDS_INFO, reason: selection.status, candidates: selection.candidates, next_question: question(selection.field, selection.options, locale, selection.status) };
        }
      }

      if (mode === 'routine_builder' && asked.length < MAX_BUILDER_QUESTIONS + 2) {
        const q = materialQuestion(profile, asked, mode, now, locale, history);
        if (q) return { ...base, status: STATUS.NEEDS_INFO, reason: 'routine_builder', playbook: playbookSummary(selection), next_question: q };
      }

      const result = evaluate(profile, selection, mode, now, history);
      return {
        ...base,
        status: result.steps.length ? STATUS.RECOMMENDED : STATUS.NO_MATCH,
        ...(result.steps.length ? {} : { reason: NO_MATCH.NO_PRODUCT }),
        playbook: playbookSummary(selection, result.scope),
        scope: result.scope,
        area: result.area,
        steps: result.steps,
        skipped: result.skipped,
        excluded: result.excluded,
        considered: result.considered,
        ...(result.pinned?.length ? { pinned: result.pinned } : {}),
        ...(selection.defaulted ? { defaulted: true } : {})
      };
    },

    /**
     * One « petit plaisir »: a treat the brand marks as such (knowledge
     * `treat`), else the config's `treats.collections`; in stock, within
     * `treats.max_price`, never one of `exclude`; best for the customer first.
     * @returns {{ product_id: string, handle: string, reasons: string[] } | null}
     */
    treat({ profile = {}, exclude = [] } = {}) {
      const spec = raw.treats ?? {};
      const known = signals.some((s) => s.knowledge);
      const skip = new Set(exclude);
      const men = valueOf(profile, 'sex_target') === 'men';
      const exclusions = valueOf(profile, 'known_exclusions') ?? [];
      const pool = signals.filter((s) => {
        if (skip.has(s.id) || !s.inStock) return false;
        if (known ? s.knowledge?.treat !== true : !(spec.collections ?? []).some((c) => s.collections.has(c))) return false;
        if (s.knowledge?.status === 'do_not_advise') return false;
        if (spec.max_price && !(s.product.priceFrom > 0 && s.product.priceFrom <= spec.max_price)) return false;
        // Any area (an eye patch is a treat), but the customer's target and exclusions hold.
        const code = exclusionOf(s, { area: [...s.areas][0] ?? 'face', men, exclusions, wantsBundle: true });
        return !code || code === EXCLUSION.WRONG_AREA;
      });
      const ranked = pool
        .map((s) => ({ s, fit: suitability(s, { profile, raw, texture: null }) }))
        .sort((a, b) => b.fit.score - a.fit.score || a.s.product.priceFrom - b.s.product.priceFrom || a.s.name.localeCompare(b.s.name));
      const best = ranked[0];
      return best ? { product_id: best.s.id, handle: best.s.handle, reasons: best.fit.reasons } : null;
    }
  };
  if (!routines || !knowledge) return playbookAdvisor;
  // The brand's own age ranges (its Rules tab) are the age values a chip or the reader may set.
  const brandAllowed = routines.age_ranges?.length ? { ...allowed, age_band: [...routines.age_ranges.map((a) => a.key), 'unknown'] } : allowed;
  const foundation = createFoundationAdvisor({ routines, catalogue, knowledge, allowed: brandAllowed, question });
  return { ...playbookAdvisor, allowed: brandAllowed, engine: 'foundations', advise: foundation.advise, treat: foundation.treat };
}

function playbookSummary(selection, scope = null) {
  const { playbook, route } = selection;
  return {
    key: playbook.key,
    route: route?.key ?? null,
    scope,
    preferred_family: playbook.preferred_family ?? null,
    // Guidance for the conversation, never product claims (rule 11).
    notes: playbook.notes ?? []
  };
}

/** The steps a scope asks for, in playbook order. */
export function slotList(playbook, route, scope) {
  const tag = (keys, optional = false) => (keys ?? []).map((key) => ({ key, optional }));
  if (route) {
    const essential = route.essential ?? route.slots ?? [];
    if (scope === 'targeted') return tag(route.targeted ?? (essential.length ? essential : route.optional), !essential.length);
    if (scope === 'essential') return essential.length ? tag(essential) : tag(route.optional, true);
    return [...tag(essential), ...tag(route.optional, true)];
  }
  const essential = playbook.essential?.slots ?? [];
  if (scope === 'targeted') return tag(playbook.targeted?.priority_slots ?? essential);
  if (scope === 'essential') return tag(essential);
  const complete = playbook.complete?.slots ?? essential;
  return complete.map((key) => ({ key, optional: key.startsWith('optional_') }));
}

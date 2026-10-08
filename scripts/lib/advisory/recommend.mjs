/**
 * The advisory engine: profile in, recommendation (or the one question that
 * would change it) out. Pure and deterministic — the same profile, config and
 * catalogue always give the same answer — so every rule is a unit test.
 *
 *   profile
 *     → selectPlaybook        gates: area, primary concern; ambiguity → a question
 *     → slots for the scope   minus what the current routine already covers
 *     → rankSlot per step     eligibility → suitability → routine fit → merchandising
 *     → next question?        routine builder only: the highest-priority unanswered
 *                             field whose answer would CHANGE the result
 *
 * CHANNEL-FREE: no prompt, no chip, no card. The storefront turns `next_question`
 * into buttons; an email draft would turn it into a sentence.
 */

import { allowedValues, isAnswered, mergeProfile, valueOf } from './profile.mjs';
import { compileConfig, productSignals } from './config.mjs';
import { selectPlaybook } from './select-playbook.mjs';
import { rankSlot, wantedTexture } from './ranking.mjs';
import { FIT, NO_MATCH, SKIPPED, STATUS } from './reason-codes.mjs';

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
 */
export function createAdvisor(rawConfig, catalogue) {
  const compiled = compileConfig(rawConfig);
  const raw = compiled.raw;
  const signals = catalogue.products.map((p) => productSignals(p, raw));
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
  function evaluate(profile, selection, mode, now) {
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
        now
      });
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
        scores: { suitability: top.suitability, routine_fit: top.routineFit, total: top.total }
      });
      if (single) break;
    }
    // One targeted product: the steps passed over on the way are not news to the customer.
    if (single && steps.length) return { playbook, route, scope, area, steps, skipped: [], excluded, considered };
    if (bestOfAll && steps.length > 1) {
      const best = steps.reduce((a, b) => (b.scores.suitability > a.scores.suitability ? b : a));
      return { playbook, route, scope, area, steps: [best], skipped: [], excluded, considered };
    }
    return { playbook, route, scope, area, steps, skipped, excluded, considered };
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
  function materialQuestion(profile, asked, mode, now, locale) {
    for (const entry of raw.selection_priority ?? []) {
      const field = PRIORITY_FIELD[entry];
      if (!field || isAnswered(profile, field) || asked.includes(field)) continue;
      const values = QUESTION_OPTIONS[field].filter((v) => v === 'unknown' || String(v).split('+').every((x) => allowed[field].includes(x)));
      const outcomes = new Set();
      for (const v of values.filter((x) => x !== 'unknown')) {
        const p = withAnswer(profile, field, v);
        const sel = selectPlaybook(p, raw);
        outcomes.add(sel.status === 'selected' ? signature(evaluate(p, sel, mode, now)) : sel.status);
      }
      if (outcomes.size > 1) return question(field, values, locale, 'changes_recommendation');
    }
    return null;
  }

  return {
    config: compiled,
    allowed,
    signals,
    label,
    /**
     * @param {{ profile: object, mode?: 'conversation' | 'routine_builder', asked?: string[], locale?: string, now?: Date }} input
     */
    advise({ profile = {}, mode = 'conversation', asked = [], locale = 'fr', now = new Date() } = {}) {
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
        const q = materialQuestion(profile, asked, mode, now, locale);
        if (q) return { ...base, status: STATUS.NEEDS_INFO, reason: 'routine_builder', playbook: playbookSummary(selection), next_question: q };
      }

      const result = evaluate(profile, selection, mode, now);
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
        ...(selection.defaulted ? { defaulted: true } : {})
      };
    }
  };
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

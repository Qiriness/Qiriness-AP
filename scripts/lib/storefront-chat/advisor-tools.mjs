/**
 * The beauty consultation, storefront side: one turn of it.
 *
 *   before the model   chip + sentence → profile updates (lexicon, ~ms)
 *                      [+ the model reader when the lexicon left words unexplained,
 *                      profile-reader.mjs] → advice
 *   the model          gets the advice as data; may call `advise` with
 *                      profile_updates the lexicon missed
 *   after              chips from next_question, cards from the steps, the new
 *                      state for the message log, events for advisory_events
 *
 * Everything that decides is in scripts/lib/advisory/ (channel-free). This file
 * only adapts it to a live chat: chips, cards, the prompt block, the log.
 */

import { extractProfile } from '../advisory/lexicon.mjs';
import { FIELDS, mergeProfile, profileSummary } from '../advisory/profile.mjs';
import { turnEvents } from '../advisory/events.mjs';
import { emptyAdvisorState } from './advisor-state.mjs';

export const ADVISE = 'advise';
export const CHANNEL = 'storefront_chat';
/** Chip value prefix: `profile:<field>:<value>[+<value>]`. */
export const PROFILE_CHOICE = /^profile:([a-z_]{1,40}):([a-z0-9_+]{1,80})$/;

export function adviseToolDefinition(advisor, { builder = false } = {}) {
  const a = advisor.allowed;
  return {
    type: 'function',
    function: {
      name: ADVISE,
      description:
        (builder
          ? 'Run the routine builder: it records what the customer said about their skin, concerns, routine or preferences, then returns either the ONE next question for their routine (with chip options) or the routine itself, built by the brand\'s playbooks. Call it with every new thing they tell you. '
          : 'Run the beauty consultation engine for a targeted need: it records what the customer said about their skin, concerns or preferences, then returns either ONE next question (with chip options) or the brand\'s top choices for that need. Use it when the customer asks for advice and the advice in VISIT CONTEXT is missing or outdated. ') +
        `Allowed values — body_area: ${a.body_area.join(', ')}; skin_type: ${a.skin_type.join(', ')}; sensitivity: ${a.sensitivity.join(', ')}; ` +
        `primary_concern / secondary_concerns: ${a.secondary_concerns.join(', ')}; current_routine: ${a.current_routine.join(', ')}; desired_care_type: ${a.desired_care_type.join(', ')}; ` +
        `routine_scope: ${a.routine_scope.join(', ')}; sex_target: men only when the customer explicitly asks for men's care; age_band: ${a.age_band.join(', ')}; age: their age in years, digits, only when they say it; eye_concern: their answer to the eye routine's « another concern around the eyes? », a concern value or none; routine_time: ${a.routine_time.join(', ')} (a day / morning routine, a night / evening routine, or both); known_exclusions: an ingredient word.`,
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          profile_updates: {
            type: 'array',
            description: 'Only what the customer actually said, mapped to the allowed values. Empty when nothing new.',
            items: {
              type: 'object',
              properties: { field: { type: 'string', enum: Object.keys(FIELDS) }, value: { type: 'string' } },
              required: ['field', 'value'],
              additionalProperties: false
            }
          },
          // Outside the skill, one product only: a routine is the routine_builder skill's (live run, 2026-10-13).
          scope: builder
            ? { type: ['string', 'null'], enum: ['targeted', 'essential', 'complete', 'complete_existing', null], description: 'Routine size the customer asked for, or null.' }
            : { type: ['string', 'null'], enum: ['targeted', null], description: 'targeted, or null. For a routine, open the routine_builder skill instead.' }
        },
        required: ['profile_updates', 'scope'],
        additionalProperties: false
      }
    }
  };
}

/**
 * @param {{
 *   advisor: ReturnType<import('../advisory/recommend.mjs').createAdvisor>,
 *   state?: ReturnType<typeof emptyAdvisorState> | null,
 *   message: string, choice?: string | null, action?: string | null, locale?: string,
 *   catalogue: { products: object[] }, money: (n: number) => string,
 *   productQuestion?: boolean,
 *   turn?: number   the customer's message number in this conversation, recorded on each profile field
 *   consultation?: boolean   an answer that continues the consultation without a profile chip (a purchase chip)
 *   stillUsing?: string[]    product ids the customer said they still use: each fills its step, never replaced
 *   ranges?: string[]        knowledge ranges the customer uses: a ranking nudge among suitable products
 *   pinned?: string[]        products to build the routine around (their interest), in the builder only
 * }} input
 */
export function createAdvisorTurn({ advisor, state = null, message, choice = null, action = null, locale = 'fr', catalogue, money, productQuestion = false, turn = 0, consultation = false, stillUsing = [], ranges = [], pinned = [] }) {
  const before = state ?? emptyAdvisorState();
  const lang = String(locale || 'fr').slice(0, 2);
  const lex = extractProfile(message, { profile: before.profile, lastAsked: before.last_question });
  // A routine asked for: the quick action, the routine words, or a routine size
  // in their words (« tout organiser du matin au soir » read as complete): the
  // routine builder skill, never a whole routine outside it (live run, 2026-10-13).
  const routineSize = lex.updates.some((u) => u.field === 'routine_scope' && u.value !== 'targeted');
  const builderAsked = action === 'build_routine' || lex.routineBuilder || routineSize;
  let mode = builderAsked ? 'routine_builder' : before.mode;

  const updates = [];
  const picked = typeof choice === 'string' ? choice.match(PROFILE_CHOICE) : null;
  if (picked) {
    for (const value of picked[2].split('+')) updates.push({ field: picked[1], value, source: 'quick_choice', confidence: 'high', replace: true });
  }
  // A chip's label arrives as the message too: the chip wins, the words add nothing new.
  if (!picked) updates.push(...lex.updates);
  // The eye question answered in words (« plutôt des rides »): the concern is its answer too.
  if (!picked && before.last_question === 'eye_concern') {
    const said = lex.updates.find((u) => u.field === 'primary_concern' || u.field === 'secondary_concerns');
    if (said) updates.push({ field: 'eye_concern', value: said.value, source: said.source, confidence: said.confidence ?? 'medium' });
  }
  // Asking for a routine supersedes « one product of this type »: the routine
  // offer after « pour hydrater mon visage » built one cream (live run, 2026-10-13).
  const base = builderAsked ? withoutSingleProduct(before.profile) : before.profile;
  let { profile, changed } = mergeProfile(base, updates, { allowed: advisor.allowed, turn });
  let advice = null;
  let asked = [...before.asked];

  // Advice is computed when the customer is in a consultation: they said
  // something about their skin or routine, clicked a profile chip, or are
  // building a routine. A question about a named product (« la crème X
  // convient aux peaux sèches ? ») still updates the profile, but is answered
  // from that product's facts, not with a routine.
  // « Trop cher » said THIS turn: the engine may answer with a cheaper product of the one just proposed.
  const priceSaidNow = lex.updates.some((u) => u.field === 'budget');
  // « Autre chose ? » about the advice just given: it counts as a consultation turn.
  const moreNow = lex.moreOptions && Boolean(before.last_advice?.product_ids?.length);
  let relevant = consultation || builderAsked || Boolean(picked) || mode === 'routine_builder' || (changed.length > 0 && !productQuestion) || moreNow;
  let rangeNudge = [...ranges];
  const compute = () => {
    advice = advisor.advise({ profile, mode, asked, locale: lang, owned: stillUsing, ranges: rangeNudge, pinned: mode === 'routine_builder' ? pinned : [], previous: priceSaidNow ? before.last_advice : moreNow ? { ...before.last_advice, more: true } : null });
    return advice;
  };

  return {
    get mode() { return mode; },
    get advice() { return advice; },
    get profile() { return profile; },
    /** What the lexicon read, and what it left unexplained (`residue`): the reader's gate. */
    lexicon: lex,
    builderAsked,
    picked: Boolean(picked),

    /**
     * The model reader's updates, merged BEFORE `opening()`. As `model_inferred`,
     * they fill what the lexicon missed and never override what it read.
     * @returns {string[]} the fields that changed
     */
    supplement(readerUpdates) {
      const merged = mergeProfile(profile, modelUpdates(readerUpdates), { allowed: advisor.allowed, turn });
      profile = merged.profile;
      changed = [...changed, ...merged.changed];
      if (merged.changed.length && !productQuestion) relevant = true;
      return merged.changed.map((c) => c.field);
    },

    opening() {
      return relevant ? compute() : null;
    },

    /**
     * The model opened the routine builder skill (use_skill) mid-turn: builder
     * mode, a routine rather than one product, and the advice computed again.
     * @returns {boolean} whether the mode changed
     */
    enterBuilder() {
      if (mode === 'routine_builder') return false;
      mode = 'routine_builder';
      profile = withoutSingleProduct(profile);
      relevant = true;
      compute();
      return true;
    },

    /**
     * The ranges the customer uses, known once their purchases are read (after
     * the opening). Re-ranks the advice already computed; true when it ran again.
     */
    useRanges(list) {
      const next = [...new Set(list ?? [])].sort();
      if (!advice || next.join('|') === [...rangeNudge].sort().join('|')) return false;
      rangeNudge = next;
      compute();
      return true;
    },

    /** The `advise` tool. Never throws: a bad update is dropped by `mergeProfile`. */
    run(args) {
      const updates = modelUpdates(args?.profile_updates);
      // A routine size is the builder's: outside it, the model may only ask for one product.
      if (typeof args?.scope === 'string' && (mode === 'routine_builder' || args.scope === 'targeted')) updates.push({ field: 'routine_scope', value: args.scope, source: 'model_inferred', confidence: 'medium' });
      const merged = mergeProfile(profile, updates, { allowed: advisor.allowed, turn });
      profile = merged.profile;
      changed = [...changed, ...merged.changed];
      return describe(compute());
    },

    describe: () => (advice ? describe(advice) : null),

    /** Products the model may show as cards. */
    handles() {
      if (!advice) return [];
      return advice.steps.flatMap((s) => [s.handle, ...s.alternatives.map((a) => a.handle)]);
    },

    /** The next question's options as chips — from the engine, never the model. */
    choices() {
      const q = advice?.next_question;
      // A size's price (foundation engine), formatted by the shop's currency: « Essentielle (2–3 produits) · 98 € ».
      return q ? q.options.map((o) => ({ label: typeof o.total === 'number' ? `${o.label} · ${money(o.total)}` : o.label, value: `profile:${q.field}:${o.value}` })) : [];
    },

    /** What the message log keeps for the next turn. */
    nextState() {
      const q = advice?.next_question ?? null;
      if (q && !asked.includes(q.field)) asked = [...asked, q.field];
      const completed = mode === 'routine_builder' && advice?.status === 'recommended';
      return {
        profile,
        // A finished routine ends the builder: later questions are a conversation again.
        mode: completed ? 'conversation' : mode,
        asked,
        last_question: q?.field ?? null,
        last_advice: advice
          ? { status: advice.status, playbook: advice.playbook?.key ?? null, scope: advice.scope, product_ids: advice.steps.map((s) => s.product_id), shown: [...new Set([...(moreNow ? before.last_advice?.shown ?? [] : []), ...advice.steps.flatMap((s) => [s.product_id, ...s.alternatives.map((a) => a.product_id)])])] }
          : before.last_advice
      };
    },

    events({ conversationRef, firstTurn }) {
      return turnEvents({ channel: CHANNEL, conversationRef, firstTurn, before, after: { mode }, changed, advice });
    },

    trace() {
      return advice
        ? { status: advice.status, mode, playbook: advice.playbook?.key ?? null, route: advice.playbook?.route ?? null, scope: advice.scope, question: advice.next_question?.field ?? null, steps: advice.steps.map((s) => ({ slot: s.slot, id: s.product_id, merchandised: s.merchandised })), ...(advice.skipped.some((s) => s.reason === 'already_owned') ? { kept: advice.skipped.filter((s) => s.reason === 'already_owned').map((s) => ({ slot: s.slot, id: s.product_id })) } : {}), ...(advice.pinned?.length ? { pinned: advice.pinned.map((p) => ({ id: p.product_id, status: p.status })) } : {}), changed: changed.map((c) => c.field) }
        : { status: 'not_run', mode, changed: changed.map((c) => c.field) };
    }
  };

  /** The advice as the prompt shows it: codes and product facts, nothing invented. */
  function describe(a) {
    const byId = new Map(catalogue.products.map((p) => [p.id, p]));
    return {
      status: a.status,
      mode,
      ...(a.reason ? { reason: a.reason } : {}),
      profile: profileSummary(profile),
      next_question: a.next_question ? { field: a.next_question.field, why: a.next_question.reason, options: a.next_question.options.map((o) => o.label) } : null,
      playbook: a.playbook,
      steps: a.steps.map((s) => ({
        step: s.slot,
        // The day routine (morning) or the night routine (evening).
        ...(s.part ? { time: s.part } : {}),
        optional: s.optional || undefined,
        product: slim(byId.get(s.product_id), money),
        ...(s.customer_interest ? { customer_interest: true } : {}),
        reason_codes: s.reason_codes,
        // Top choices: the alternatives are presented too, so they carry their facts.
        ...(s.top_choices ? { top_choices: true } : {}),
        alternatives: s.alternatives.map((x) => (s.top_choices ? { ...slim(byId.get(x.product_id), money) } : { handle: x.handle, name: byId.get(x.product_id)?.name ?? null }))
      })),
      // already_owned: a product they said they still use fills it; the model says to keep theirs.
      skipped_steps: a.skipped.map((s) => ({
        step: s.slot,
        ...(s.part ? { time: s.part } : {}),
        reason: s.reason,
        // also_in_day_routine: the day routine's product, used in the evening too.
        ...(s.product_id && s.reason === 'also_in_day_routine' ? { product: byId.get(s.product_id)?.name ?? null } : s.product_id && s.reason !== 'over_budget' ? { customer_product: byId.get(s.product_id)?.name ?? null } : {})
      })),
      // The routine's price, and what a budget left out: quoted from here, never computed by the model.
      ...(typeof a.total_price === 'number' ? { total_price: money(a.total_price) } : {}),
      ...(a.cheaper_than ? { cheaper_than: byId.get(a.cheaper_than)?.name ?? null } : {}),
      ...(a.budget ? { budget: { max: money(a.budget.max), total: money(a.budget.total), left_out: a.budget.dropped.length } } : {}),
      // The product they came for, when it could not go in: say why, briefly.
      ...((a.pinned ?? []).some((p) => p.status !== 'placed') ? { customer_interest_not_used: a.pinned.filter((p) => p.status !== 'placed').map((p) => ({ name: byId.get(p.product_id)?.name ?? null, why: p.status })) } : {}),
      ...(a.defaulted ? { defaulted_after_question: true } : {})
    };
  }
}

/** The profile without what limits it to one product: a care type, a targeted scope. */
function withoutSingleProduct(profile = {}) {
  const { desired_care_type: _type, ...rest } = profile;
  if (rest.routine_scope?.value === 'targeted') delete rest.routine_scope;
  return rest;
}

/** Profile updates a model wrote → merge-ready, as `model_inferred`. A bad value is dropped later by `mergeProfile`. */
function modelUpdates(list) {
  return (Array.isArray(list) ? list : [])
    .slice(0, 12)
    .filter((u) => u && typeof u.field === 'string' && typeof u.value === 'string')
    .map((u) => ({ field: u.field, value: u.value.trim().toLowerCase().replace(/[\s-]+/g, '_'), source: 'model_inferred', confidence: 'medium' }))
    .map((u) => (u.field === 'known_exclusions' || u.field === 'preferences' ? { ...u, value: u.value.replace(/_/g, ' ') } : u));
}

/** The facts of a step's product: from product data only (rule 11). */
function slim(p, money) {
  if (!p) return null;
  return {
    handle: p.handle,
    name: p.name,
    short: clip(p.short, 220),
    key_ingredients: clip(p.keyIngredients, 220),
    how_to_use: clip(p.usage, 180),
    price_from: p.priceFrom === null ? null : money(p.priceFrom),
    in_stock: p.inStock
  };
}

function clip(value, max) {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

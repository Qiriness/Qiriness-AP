/**
 * The beauty consultation, storefront side: one turn of it.
 *
 *   before the model   chip + sentence → profile updates (lexicon, ~ms) → advice
 *   the model          gets the advice as data; may call `advise` with
 *                      profile_updates the lexicon missed
 *   after              chips from next_question, cards from the steps, the new
 *                      state for the message log, events for advisory_events
 *
 * Everything that decides is in scripts/lib/advisory/ (channel-free). This file
 * only adapts it to a live chat: chips, cards, the prompt block, the log.
 */

import { extractProfile } from '../advisory/lexicon-fr.mjs';
import { FIELDS, mergeProfile, profileSummary } from '../advisory/profile.mjs';
import { turnEvents } from '../advisory/events.mjs';
import { emptyAdvisorState } from './advisor-state.mjs';

export const ADVISE = 'advise';
export const CHANNEL = 'storefront_chat';
/** Chip value prefix: `profile:<field>:<value>[+<value>]`. */
export const PROFILE_CHOICE = /^profile:([a-z_]{1,40}):([a-z0-9_+]{1,80})$/;

export function adviseToolDefinition(advisor) {
  const a = advisor.allowed;
  return {
    type: 'function',
    function: {
      name: ADVISE,
      description:
        'Run the beauty consultation engine: it records what the customer said about their skin, concerns, routine or preferences, then returns either ONE next question (with chip options) or a routine of brand products chosen by the brand\'s playbooks. Use it when the customer asks for advice and the advice in VISIT CONTEXT is missing or outdated. ' +
        `Allowed values — body_area: ${a.body_area.join(', ')}; skin_type: ${a.skin_type.join(', ')}; sensitivity: ${a.sensitivity.join(', ')}; ` +
        `primary_concern / secondary_concerns: ${a.secondary_concerns.join(', ')}; current_routine: ${a.current_routine.join(', ')}; desired_care_type: ${a.desired_care_type.join(', ')}; ` +
        `routine_scope: ${a.routine_scope.join(', ')}; sex_target: men only when the customer explicitly asks for men's care; age_band: ${a.age_band.join(', ')}; known_exclusions: an ingredient word.`,
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
          scope: { type: ['string', 'null'], enum: ['targeted', 'essential', 'complete', 'complete_existing', null], description: 'Routine size the customer asked for, or null.' }
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
 * }} input
 */
export function createAdvisorTurn({ advisor, state = null, message, choice = null, action = null, locale = 'fr', catalogue, money, productQuestion = false, turn = 0 }) {
  const before = state ?? emptyAdvisorState();
  const lang = String(locale || 'fr').slice(0, 2);
  const lex = extractProfile(message, { profile: before.profile, lastAsked: before.last_question });
  const builderAsked = action === 'build_routine' || lex.routineBuilder;
  const mode = builderAsked ? 'routine_builder' : before.mode;

  const updates = [];
  const picked = typeof choice === 'string' ? choice.match(PROFILE_CHOICE) : null;
  if (picked) {
    for (const value of picked[2].split('+')) updates.push({ field: picked[1], value, source: 'quick_choice', confidence: 'high', replace: true });
  }
  // A chip's label arrives as the message too: the chip wins, the words add nothing new.
  if (!picked) updates.push(...lex.updates);
  let { profile, changed } = mergeProfile(before.profile, updates, { allowed: advisor.allowed, turn });
  let advice = null;
  let asked = [...before.asked];

  // Advice is computed when the customer is in a consultation: they said
  // something about their skin or routine, clicked a profile chip, or are
  // building a routine. A question about a named product (« la crème X
  // convient aux peaux sèches ? ») still updates the profile, but is answered
  // from that product's facts, not with a routine.
  const relevant = builderAsked || Boolean(picked) || mode === 'routine_builder' || (changed.length > 0 && !productQuestion);
  const compute = () => {
    advice = advisor.advise({ profile, mode, asked, locale: lang });
    return advice;
  };

  return {
    mode,
    get advice() { return advice; },
    get profile() { return profile; },

    opening() {
      return relevant ? compute() : null;
    },

    /** The `advise` tool. Never throws: a bad update is dropped by `mergeProfile`. */
    run(args) {
      const modelUpdates = (Array.isArray(args?.profile_updates) ? args.profile_updates : [])
        .slice(0, 12)
        .filter((u) => u && typeof u.field === 'string' && typeof u.value === 'string')
        .map((u) => ({ field: u.field, value: u.value.trim().toLowerCase().replace(/[\s-]+/g, '_'), source: 'model_inferred', confidence: 'medium' }))
        .map((u) => (u.field === 'known_exclusions' || u.field === 'preferences' ? { ...u, value: u.value.replace(/_/g, ' ') } : u));
      if (typeof args?.scope === 'string') modelUpdates.push({ field: 'routine_scope', value: args.scope, source: 'model_inferred', confidence: 'medium' });
      const merged = mergeProfile(profile, modelUpdates, { allowed: advisor.allowed, turn });
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
      return q ? q.options.map((o) => ({ label: o.label, value: `profile:${q.field}:${o.value}` })) : [];
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
          ? { status: advice.status, playbook: advice.playbook?.key ?? null, scope: advice.scope, product_ids: advice.steps.map((s) => s.product_id) }
          : before.last_advice
      };
    },

    events({ conversationRef, firstTurn }) {
      return turnEvents({ channel: CHANNEL, conversationRef, firstTurn, before, after: { mode }, changed, advice });
    },

    trace() {
      return advice
        ? { status: advice.status, mode, playbook: advice.playbook?.key ?? null, route: advice.playbook?.route ?? null, scope: advice.scope, question: advice.next_question?.field ?? null, steps: advice.steps.map((s) => ({ slot: s.slot, id: s.product_id, merchandised: s.merchandised })), changed: changed.map((c) => c.field) }
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
        optional: s.optional || undefined,
        product: slim(byId.get(s.product_id), money),
        reason_codes: s.reason_codes,
        alternatives: s.alternatives.map((x) => ({ handle: x.handle, name: byId.get(x.product_id)?.name ?? null }))
      })),
      skipped_steps: a.skipped.map((s) => ({ step: s.slot, reason: s.reason })),
      ...(a.defaulted ? { defaulted_after_question: true } : {})
    };
  }
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

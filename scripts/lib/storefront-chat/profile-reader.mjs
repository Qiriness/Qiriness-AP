/**
 * The lexicon's backup: when the customer talks about their skin in words the
 * lexicon does not know (« my face feels like sandpaper », « ma peau est comme
 * du papier de verre »), ONE small model call reads the message into the
 * engine's own values before the engine decides.
 *
 *   lexicon (~1 ms, always)  → what it understood + `residue`, what it did not
 *   shouldRead               → a consultation turn with residue, or nothing read
 *   readProfile (~1–2 s)     → profile_updates in the shop's vocabulary
 *   mergeProfile             → as `model_inferred`: the lexicon wins a conflict
 *
 * WHY NOT LET THE REPLY MODEL CALL `advise` ITSELF: it can, and still does, but
 * only after the advice in its prompt was computed from a partial profile. A
 * partial reading is worse than none (2026-10-12: « tight and dull » read as
 * « dull » alone, and the engine recommended a firming serum).
 *
 * NEVER BLOCKS THE TURN. A failure, a timeout or an invalid answer leaves the
 * lexicon's reading as it was.
 */

import { FIELDS } from '../advisory/profile.mjs';

export const READER_TIMEOUT_MS = 2500;
/** Mapping words to a fixed vocabulary needs little thought; the default effort took 2–4 s (2026-10-12). */
export const READER_REASONING = 'none';
const MAX_UPDATES = 12;

/** Words that make a message about the skin even when the lexicon read nothing of it (French and English). */
const SKIN = /\b(skin|peau|peaux|teint|complexion|face|visage|pores?|lips?|levres?|cheeks?|joues?|forehead|front|eyes?|yeux|hands?|mains?|body|corps)\b/;
export function mentionsSkin(message) {
  const text = ` ${String(message ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  return SKIN.test(text);
}

/**
 * Should the model read this message? Only a consultation turn, and only when
 * the lexicon left words it did not explain, or read nothing at all.
 *
 * @param {{
 *   lexicon: { updates: object[], residue: string[], routineBuilder: boolean },
 *   state: { mode?: string, last_question?: string | null } | null,
 *   choice?: string | null, productQuestion?: boolean, otherTopic?: boolean, skinWords?: boolean
 * }} input
 * @returns {{ read: boolean, reason: string }}
 */
export function shouldRead({ lexicon, state = null, choice = null, productQuestion = false, otherTopic = false, skinWords = false }) {
  if (choice) return { read: false, reason: 'chip' };
  if (productQuestion) return { read: false, reason: 'product_question' };
  if (otherTopic) return { read: false, reason: 'other_topic' };
  if (!lexicon.residue.length) return { read: false, reason: 'fully_read' };
  const consultation = lexicon.updates.length > 0 || lexicon.routineBuilder || state?.mode === 'routine_builder' || Boolean(state?.last_question) || skinWords;
  if (!consultation) return { read: false, reason: 'not_a_consultation' };
  return { read: true, reason: lexicon.updates.length ? 'unexplained_words' : 'nothing_read' };
}

/** The reader's answer: the same shape as the `advise` tool's profile_updates. */
const READ_SCHEMA = {
  type: 'object',
  properties: {
    profile_updates: {
      type: 'array',
      items: {
        type: 'object',
        properties: { field: { type: 'string', enum: Object.keys(FIELDS) }, value: { type: 'string' } },
        required: ['field', 'value'],
        additionalProperties: false
      }
    }
  },
  required: ['profile_updates'],
  additionalProperties: false
};

function readerPrompt(allowed, lastQuestion) {
  return [
    "You read ONE message a customer wrote to a skincare shop's advisor, in any language, and record what it says about the customer's skin and needs.",
    'Return only what the message says or clearly means. Nothing about other people unless the product is for them. Never guess age or sex.',
    'Map everyday words to the allowed values: « feels like sandpaper » is dryness; « tight » is tightness; « breaks out » is imperfections; « shiny by noon » is shine.',
    'List concerns most important first: the first primary_concern is the main complaint; further concerns go in secondary_concerns.',
    `Allowed values — body_area: ${allowed.body_area.join(', ')}; skin_type: ${allowed.skin_type.join(', ')}; sensitivity: ${allowed.sensitivity.join(', ')}; ` +
      `primary_concern / secondary_concerns: ${allowed.secondary_concerns.join(', ')}; current_routine: ${allowed.current_routine.join(', ')}; desired_care_type: ${allowed.desired_care_type.join(', ')}; ` +
      `routine_scope: ${allowed.routine_scope.join(', ')}; sex_target: men only when the message explicitly asks for men's care; age_band: ${allowed.age_band.join(', ')}; age: their age in years, digits, only when they say it; routine_time: ${allowed.routine_time.join(', ')} (a day / morning routine, a night / evening routine, or both); known_exclusions: an ingredient word.`,
    ...(lastQuestion ? [`The advisor has just asked about: ${lastQuestion}. A short answer answers that.`] : []),
    'Return an empty list when the message says nothing about the skin.'
  ].join('\n');
}

/**
 * @param {{
 *   client: { completeWithTools: Function }, model: string, message: string,
 *   allowed: Record<string, string[]>, lastQuestion?: string | null,
 *   timeoutMs?: number
 * }} input
 * @returns {Promise<{ status: 'read' | 'failed', updates: { field: string, value: string }[], ms: number, usage: object | null }>}
 */
export async function readProfile({ client, model, message, allowed, lastQuestion = null, timeoutMs = READER_TIMEOUT_MS, reasoningEffort = READER_REASONING }) {
  const started = Date.now();
  let timer;
  try {
    const result = await Promise.race([
      client.completeWithTools({
        model,
        system: readerPrompt(allowed, lastQuestion),
        messages: [{ role: 'user', content: String(message).slice(0, 1000) }],
        schema: READ_SCHEMA,
        schemaName: 'profile_reading',
        maxTokens: 400,
        reasoningEffort,
        pass: 'storefront_profile_read'
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); })
    ]);
    const parsed = JSON.parse(result?.content ?? '{}');
    const updates = (Array.isArray(parsed.profile_updates) ? parsed.profile_updates : [])
      .filter((u) => u && typeof u.field === 'string' && typeof u.value === 'string')
      .slice(0, MAX_UPDATES);
    return { status: 'read', updates, ms: Date.now() - started, usage: result?.usage ?? null };
  } catch {
    return { status: 'failed', updates: [], ms: Date.now() - started, usage: null };
  } finally {
    clearTimeout(timer);
  }
}

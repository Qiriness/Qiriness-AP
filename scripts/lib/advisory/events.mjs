/**
 * Advisory analytics events: one schema for every channel.
 *
 *   { channel, conversation_ref, event_type, playbook_key, product_ids, payload }
 *
 * `channel` is `storefront_chat` today and `email` later; `conversation_ref` is
 * the chat session id today and a ticket id later. Payloads carry codes,
 * counts and ids — never the customer's words — so the table can be kept and
 * aggregated without holding personal data.
 *
 * `turnEvents` derives a turn's events from the advisory state before and
 * after it, so any channel that keeps the same state gets the same events.
 */

export const CHANNELS = ['storefront_chat', 'email'];

export const EVENT_TYPES = [
  'conversation_started',
  'advisory_started',
  'routine_builder_started',
  'routine_builder_completed',
  'profile_field_collected',
  'clarification_asked',
  'products_considered',
  'products_recommended',
  'product_clicked',
  'added_to_cart',
  'recommendation_abandoned',
  'unresolved_question',
  'support_handoff',
  'purchase'
];

const MAX_PAYLOAD_STRING = 80;
const MAX_PRODUCT_IDS = 12;

/** A payload of codes and numbers only: strings are cut, nesting at most three levels (steps → step → reasons). */
function cleanPayload(value, depth = 0) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, MAX_PAYLOAD_STRING);
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => cleanPayload(v, depth + 1)).filter((v) => v !== undefined);
  if (typeof value === 'object' && depth < 3) {
    return Object.fromEntries(Object.entries(value).slice(0, 30).map(([k, v]) => [k.slice(0, 40), cleanPayload(v, depth + 1)]).filter(([, v]) => v !== undefined));
  }
  return undefined;
}

/** One validated event, or null when it does not fit the schema. */
export function createEvent({ channel, conversationRef, type, playbookKey = null, productIds = [], payload = {} }) {
  if (!CHANNELS.includes(channel) || !EVENT_TYPES.includes(type)) return null;
  if (typeof conversationRef !== 'string' || !conversationRef) return null;
  return {
    channel,
    conversation_ref: conversationRef,
    event_type: type,
    playbook_key: typeof playbookKey === 'string' ? playbookKey.slice(0, 80) : null,
    product_ids: (productIds ?? []).filter((id) => typeof id === 'string').slice(0, MAX_PRODUCT_IDS),
    payload: cleanPayload(payload) ?? {}
  };
}

/**
 * The events one turn produced.
 * @param {{
 *   channel: string, conversationRef: string, firstTurn: boolean,
 *   before: { mode?: string, last_advice?: object | null } | null,
 *   after: { mode?: string },
 *   changed: { field: string, source: string }[],
 *   advice: object | null
 * }} turn
 */
export function turnEvents({ channel, conversationRef, firstTurn, before, after, changed, advice }) {
  const out = [];
  const push = (type, extra = {}) => {
    const e = createEvent({ channel, conversationRef, type, ...extra });
    if (e) out.push(e);
  };
  const playbookKey = advice?.playbook?.key ?? null;
  if (firstTurn) push('conversation_started');
  const advisoryBefore = Boolean(before?.last_advice || before?.mode === 'routine_builder' || Object.keys(before?.profile ?? {}).length);
  if (!advisoryBefore && (advice || changed.length)) push('advisory_started');
  if (after.mode === 'routine_builder' && before?.mode !== 'routine_builder') push('routine_builder_started');
  for (const c of changed) push('profile_field_collected', { payload: { field: c.field, source: c.source } });
  if (!advice) return out;
  if (advice.next_question) push('clarification_asked', { playbookKey, payload: { field: advice.next_question.field, reason: advice.next_question.reason ?? null } });
  if (advice.status === 'recommended') {
    push('products_considered', { playbookKey, payload: { considered: advice.considered, excluded: advice.excluded } });
    push('products_recommended', {
      playbookKey,
      productIds: advice.steps.map((s) => s.product_id),
      payload: {
        scope: advice.scope,
        route: advice.playbook?.route ?? null,
        steps: advice.steps.map((s) => ({ slot: s.slot, reasons: s.reason_codes.map((r) => r.split(':')[0]), merchandised: s.merchandised })),
        merchandised_ids: advice.steps.filter((s) => s.merchandised).map((s) => s.product_id),
        skipped: advice.skipped.map((s) => ({ slot: s.slot, reason: s.reason }))
      }
    });
    if (after.mode === 'routine_builder' && before?.last_advice?.status !== 'recommended') push('routine_builder_completed', { playbookKey, payload: { steps: advice.steps.length } });
  }
  return out;
}

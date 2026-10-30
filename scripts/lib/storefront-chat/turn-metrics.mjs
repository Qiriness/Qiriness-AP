/**
 * One storefront chat turn as an analytics row (`storefront_agent_turns`):
 * how it was answered, how long it took, what it cost in tokens, whether it
 * failed, fell back, left a question unanswered or sent the customer to
 * customer service, and which products it showed. Never the customer's words.
 *
 * Pure: the live service hands it the agent's reply and the measured latency;
 * the backfill hands it a reply rebuilt from the stored message log. Both land
 * on the same vocabulary, so a turn from either reads the same on the dashboard.
 *
 * THE INTENT IS A RULE OVER THE TRACE, not a model's guess: what the turn did
 * (the routine builder, a purchase question, an order lookup, a policy or FAQ
 * lookup, products) decides it, in that priority. A conversation's intent is
 * the one most of its turns had (SQL, `storefront_agent_conversations`).
 */

import { DEFAULT_MAX_TOOL_ROUNDS } from './llm-agent.mjs';
import { KNOWLEDGE_TOOL_NAMES } from './knowledge-tools.mjs';
import { ORDER_TOOL } from './order-tools.mjs';

/** Mirrors `storefront_agent_turns_route_check`. `rules`: answered by the code, no model call. */
export const TURN_ROUTES = ['llm', 'rules', 'mock'];
/** Mirrors `storefront_agent_turns_status_check`. */
export const TURN_STATUSES = ['answered', 'failed'];
/** Mirrors `storefront_agent_turns_intent_check`, in priority order (`other` last). */
export const TURN_INTENTS = ['routine_building', 'reordering', 'customer_service', 'faq', 'product_discovery', 'other'];
/** Mirrors `storefront_agent_turns_fallbacks_check`. */
export const TURN_FALLBACKS = ['source_unavailable', 'forced_answer', 'lexicon_backup'];

const ROUTINE_RULES = new Set(['builder_question', 'routine_cards']);
const BUYING_RULES = new Set(['cart_add', 'cart_no', 'cart_ask']);
const FAQ_ROUTES = new Set(['general_policy', 'general_faq', 'product_and_policy']);
const FAQ_ACTIONS = new Set(['offers', 'delivery_returns']);
const DISCOVERY_ACTIONS = new Set(['find_product', 'compare']);
const PRODUCT_TOOLS = new Set(['search_products', 'resolve_products', 'get_product', 'advise']);
const FAILED = new Set(['unavailable', 'failed', 'error']);
const MAX_PRODUCT_IDS = 24;

const list = (value) => (Array.isArray(value) ? value : []);
const count = (n) => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

/** Every lookup the turn ran, by the model or by the code before it: `{ name, status }`. */
function lookups(trace) {
  return [
    ...list(trace?.tools).map((t) => ({ name: t?.name ?? null, status: t?.status ?? null })),
    ...list(trace?.knowledge?.retrievals).map((r) => ({ name: r?.tool ?? null, status: r?.status ?? null })),
    ...list(trace?.shopping?.retrievals).map((r) => ({ name: r?.tool ?? null, status: r?.status ?? null })),
  ];
}

/**
 * The products a reply showed: its cards, its follow-up's cards and its routine
 * cards. Live replies carry ids on their cards; the backfill passes its own.
 */
export function shownProductIds(reply) {
  const ids = [
    ...list(reply?.products).map((p) => p?.id),
    ...list(reply?.followUp?.products).map((p) => p?.id),
    ...list(reply?.routineView?.moments).flatMap((m) => list(m?.steps).map((s) => s?.product_id)),
  ];
  return [...new Set(ids.filter((id) => typeof id === 'string' && id))].slice(0, MAX_PRODUCT_IDS);
}

/**
 * What the turn was about, from what it did. First match wins.
 *
 * @param {{ trace?: object, action?: string | null, mode?: string | null, opening?: boolean,
 *   escalated?: boolean, shown?: number, orderLookups?: number }} turn
 */
export function intentOfTurn({ trace = null, action = null, mode = null, opening = false, escalated = false, shown = 0, orderLookups = 0 }) {
  const rule = trace?.model_skipped ?? null;
  const ran = lookups(trace);
  const names = new Set(ran.map((l) => l.name));

  if (mode === 'routine_builder' || ROUTINE_RULES.has(rule) || trace?.skill_opened || trace?.routine_view || action === 'build_routine') {
    return 'routine_building';
  }
  if (opening || rule === 'purchase_question' || names.has('get_past_purchases')) return 'reordering';
  if (orderLookups > 0 || names.has(ORDER_TOOL) || trace?.order_reminder || escalated) return 'customer_service';
  if (
    FAQ_ROUTES.has(trace?.knowledge?.route) ||
    KNOWLEDGE_TOOL_NAMES.some((n) => names.has(n)) ||
    trace?.shopping ||
    FAQ_ACTIONS.has(action)
  ) {
    return 'faq';
  }
  if (shown > 0 || BUYING_RULES.has(rule) || DISCOVERY_ACTIONS.has(action) || mode === 'conversation' || [...PRODUCT_TOOLS].some((n) => names.has(n))) {
    return 'product_discovery';
  }
  return 'other';
}

/**
 * The analytics row of one turn.
 *
 * @param {{
 *   shopDomain: string, conversationId: string, userMessageId?: string | null,
 *   startedAt: Date | string | number, latencyMs: number, action?: string | null, opening?: boolean,
 *   reply?: object | null, error?: { code: string } | null,
 *   productIds?: string[] | null, escalated?: boolean | null, backfilled?: boolean
 * }} input
 */
export function turnRecord({
  shopDomain,
  conversationId,
  userMessageId = null,
  startedAt,
  latencyMs,
  action = null,
  opening = false,
  reply = null,
  error = null,
  productIds = null,
  escalated = null,
  backfilled = false,
}) {
  const trace = reply?.trace ?? null;
  const rule = trace?.model_skipped ?? null;
  const calls = list(trace?.calls).filter((ms) => Number.isFinite(ms));
  const ran = lookups(trace);
  const failures = ran.filter((l) => FAILED.has(l.status)).length + (trace?.purchases?.status === 'failed' ? 1 : 0);
  const knowledge = ran.filter((l) => KNOWLEDGE_TOOL_NAMES.includes(l.name));
  const shown = productIds ?? shownProductIds(reply);
  const sentToService = escalated ?? Boolean(reply?.contact);
  const orderLookups = count(reply?.orderLookups);

  const fallbacks = [];
  if (failures > 0) fallbacks.push('source_unavailable');
  // The model used every tool round and was told to answer with what it had.
  if (calls.length > DEFAULT_MAX_TOOL_ROUNDS) fallbacks.push('forced_answer');
  // The skin lexicon could not read the message and a model read it instead.
  if (trace?.advice?.reader?.status) fallbacks.push('lexicon_backup');

  // A failed turn is the model's: only the LLM agent throws (StorefrontAgentError).
  const route = error
    ? 'llm'
    : rule
      ? 'rules'
      : calls.length || reply?.model
        ? 'llm'
        : 'mock';

  return {
    shop_domain: shopDomain,
    conversation_id: conversationId,
    user_message_id: userMessageId,
    created_at: new Date(startedAt).toISOString(),
    status: error ? 'failed' : 'answered',
    error_code: error ? String(error.code).slice(0, 40) : null,
    route,
    rule: rule ? String(rule).slice(0, 40) : null,
    intent: error
      ? 'other'
      : intentOfTurn({ trace, action, mode: reply?.advisor?.mode ?? null, opening, escalated: sentToService, shown: shown.length, orderLookups }),
    action: action ? String(action).slice(0, 40) : null,
    model: reply?.model ?? null,
    model_calls: calls.length,
    model_ms: calls.length ? calls.reduce((a, b) => a + b, 0) : null,
    input_tokens: count(reply?.usage?.inputTokens),
    output_tokens: count(reply?.usage?.outputTokens),
    tool_calls: ran.length,
    tool_failures: failures,
    fallbacks,
    // A knowledge question the policies and FAQs had nothing for.
    unanswered: knowledge.length > 0 && !knowledge.some((l) => l.status === 'found'),
    escalated: sentToService,
    product_ids: shown,
    latency_ms: count(latencyMs),
    backfilled,
  };
}

/** A failed turn's code: the agent's own deadline, or the model call itself. */
export function failureCode(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /no reply within/i.test(message) ? 'timeout' : 'model_error';
}

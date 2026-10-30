/**
 * The turns of conversations held before `storefront_agent_turns` existed,
 * rebuilt from the chat log (`storefront_chat_messages`). Pure.
 *
 * WHAT IS APPROXIMATE, AND MARKED `backfilled`:
 *   - latency is the gap between the stored question and the stored reply (the
 *     question is written while the agent already runs, so a few ms short);
 *   - « sent to customer service » is read off the reply (an order lookup, or
 *     contact words), since the contact link itself was not logged;
 *   - a question with no reply before the next question (or ever) is a failed
 *     turn, code `no_reply`.
 * Everything else — route, model, tokens, model time, tools, fallbacks, intent,
 * products — is the trace the live turn wrote.
 */

import { CONTACT_WORDS } from './llm-agent.mjs';
import { turnRecord } from './turn-metrics.mjs';

/** A question younger than this may still be answering: not judged yet. */
export const SETTLE_MS = 5 * 60 * 1000;

const handleOf = (url) => {
  const match = /\/products\/([^/?#]+)/.exec(String(url ?? ''));
  return match ? decodeURIComponent(match[1]) : null;
};

/**
 * @param {{ id: string, session_id: string, role: 'user' | 'assistant', content: string, action: string | null,
 *   context: object | null, model: string | null, input_tokens: number | null, output_tokens: number | null,
 *   created_at: string }[]} messages  one shop's log, any order
 * @param {{ shopDomain: string, productIdByHandle: Map<string, string>, now?: Date, skip?: Set<string> }} options
 *   `skip`: user message ids that already have a turn.
 */
export function backfillTurns(messages, { shopDomain, productIdByHandle, now = new Date(), skip = new Set() }) {
  const bySession = new Map();
  for (const m of messages) {
    if (!bySession.has(m.session_id)) bySession.set(m.session_id, []);
    bySession.get(m.session_id).push(m);
  }
  const rows = [];
  for (const [sessionId, log] of bySession) {
    log.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    log.forEach((m, i) => {
      if (m.role !== 'user' || skip.has(m.id)) return;
      const next = log.slice(i + 1);
      const replyRow = next.find((r) => r.role === 'assistant');
      const nextQuestion = next.find((r) => r.role === 'user');
      const answered = replyRow && (!nextQuestion || Date.parse(replyRow.created_at) <= Date.parse(nextQuestion.created_at));
      if (!answered && !nextQuestion && now - Date.parse(m.created_at) < SETTLE_MS) return;
      const before = log.slice(0, i).reverse().find((r) => r.role === 'assistant');
      const base = {
        shopDomain,
        conversationId: sessionId,
        userMessageId: m.id,
        startedAt: m.created_at,
        action: m.action,
        // The question answers the repurchase message the conversation opened with.
        opening: Boolean(before?.context?.opening),
        backfilled: true,
      };
      if (!answered) {
        rows.push(turnRecord({ ...base, latencyMs: 0, error: { code: 'no_reply' } }));
        return;
      }
      const context = replyRow.context ?? {};
      const trace = context.trace ?? null;
      const urls = [...(context.products ?? []), ...(context.follow_up?.products ?? [])];
      const productIds = [...new Set(urls.map(handleOf).map((h) => (h ? productIdByHandle.get(h) : null)).filter(Boolean))];
      const orderAnswered = (trace?.tools ?? []).some((t) => t?.name === 'get_order_status') || Number(context.order_lookups) > 0;
      rows.push(
        turnRecord({
          ...base,
          latencyMs: Date.parse(replyRow.created_at) - Date.parse(m.created_at),
          reply: {
            model: replyRow.model,
            usage: { inputTokens: replyRow.input_tokens ?? 0, outputTokens: replyRow.output_tokens ?? 0 },
            trace,
            advisor: context.advisor ?? null,
            orderLookups: Number(context.order_lookups) || 0,
          },
          productIds,
          escalated: orderAnswered || CONTACT_WORDS.test(replyRow.content ?? ''),
        })
      );
    });
  }
  return rows;
}

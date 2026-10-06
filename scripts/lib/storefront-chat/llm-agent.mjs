/**
 * storefront_sales_agent on a model. Same `respond` contract as the mock
 * (agent.mjs), so the service does not know which one answers.
 *
 * Phase 2 was one call and no tools. Phase 3 hands it a `catalogue` and with it
 * two read-only tools (product-tools.mjs): the model may call them for at most
 * `maxToolRounds` rounds, then must answer. Without a catalogue it is Phase 2.
 *
 * The client is injected — `createOpenAIClient` from agent/src/llm, wired by
 * the server with `storefrontFetch` / `noRetryWait` below — so this file is
 * testable without a network and the provider stays replaceable.
 *
 * A SHOPPER IS WAITING, so the design is about round trips:
 *   - the product page the customer is on goes into the prompt, so « is this
 *     good for dry skin? » is ONE call, not a lookup and then an answer;
 *   - tools answer from memory, so a tool round costs only the model's time;
 *   - several tool calls in one round run together;
 *   - the whole turn has one wall-clock deadline, each request its own timeout,
 *     and a rate limit is not waited out. A failure becomes « Réessayer ».
 *
 * A PRODUCT CARD IS ONLY EVER A PRODUCT THE TOOLS RETURNED (or the page's own
 * product, or one the resolver identified). A handle the model writes from
 * nowhere is dropped, not shown.
 *
 * WHICH PRODUCTS THE CUSTOMER MEANS is settled before the model is called
 * (product-resolver.mjs, about a millisecond): « la crème Source d'Eau Riche »,
 * « les deux », « ça » on a product page arrive in the prompt as resolved
 * products with their facts, so the commonest reference costs no tool round.
 * An ambiguous one arrives as a clarification the resolver built; its options
 * go to the widget as chips, from the data, never from the model.
 */

import { STOREFRONT_AGENT_NAME } from './agent.mjs';
import { priceFormatter, productDetail, runTool, toolDefinitions } from './product-tools.mjs';
import { buildResolutionIndex, resolveProducts } from './product-resolver.mjs';
import { buildStorefrontSystemPrompt } from './system-prompt.mjs';

export const DEFAULT_STOREFRONT_MODEL = 'gpt-6-luna';
/** One model request. */
export const DEFAULT_TIMEOUT_MS = 12_000;
/** The whole turn, tool rounds included. */
export const DEFAULT_TURN_DEADLINE_MS = 20_000;
export const DEFAULT_MAX_TOOL_ROUNDS = 2;

/** Visible reply budget. A widget answer is a few sentences and up to three cards. */
const MAX_REPLY_TOKENS = 500;
/** A runaway reply is cut rather than shown whole in a 400px panel. */
const MAX_REPLY_CHARS = 1200;
/** Per history message: the agent needs the gist of earlier turns, not every word. */
const MAX_HISTORY_CHARS = 1500;
const MAX_CARDS = 3;
const MAX_RATIONALE_CHARS = 140;

const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    products: {
      type: 'array',
      description: 'Products to show as cards under the reply, best first. Empty when none is suggested.',
      items: {
        type: 'object',
        properties: {
          handle: { type: 'string' },
          rationale: { type: 'string', description: 'Why it fits this customer, in one short phrase, in the reply language.' }
        },
        required: ['handle', 'rationale'],
        additionalProperties: false
      }
    }
  },
  required: ['reply', 'products'],
  additionalProperties: false
};

const FINAL_ROUND_NOTE =
  'No more tool calls are available. Answer the customer now, using the products already returned above: they are verified catalogue data, so name them and list the best ones in `products`.';

export class StorefrontAgentError extends Error {}

/**
 * @param {{
 *   client: { completeWithTools: Function },
 *   model?: string,
 *   company?: { name?: string | null, description?: string | null },
 *   catalogue?: import('./product-repository.mjs').Catalogue | null,
 *   currency?: string,
 *   productBaseUrl?: string | null,
 *   deadlineMs?: number,
 *   maxToolRounds?: number
 * }} deps
 */
export function createLlmAgent({
  client,
  model = DEFAULT_STOREFRONT_MODEL,
  company = {},
  catalogue = null,
  currency = 'EUR',
  productBaseUrl = null,
  deadlineMs = DEFAULT_TURN_DEADLINE_MS,
  maxToolRounds = DEFAULT_MAX_TOOL_ROUNDS
}) {
  if (!client?.completeWithTools) throw new Error('createLlmAgent needs an OpenAI client.');
  const tools = catalogue ? toolDefinitions(catalogue) : null;
  const linkBase = productLinkBase(productBaseUrl);
  const resolutionIndex = catalogue ? buildResolutionIndex(catalogue) : null;

  return {
    name: STOREFRONT_AGENT_NAME,
    model,
    /**
     * @param {{
     *   message: string,
     *   action?: string | null,
     *   context?: { locale?: string | null, productHandle?: string | null },
     *   history?: { role: string, content: string }[],
     *   refs?: import('./conversation-refs.mjs').ConversationRefs | null,
     *   choice?: string | null
     * }} turn
     * @returns {Promise<import('./agent.mjs').AgentReply>}
     */
    async respond({ message, context = {}, history = [], refs = null, choice = null }) {
      const locale = context.locale || 'fr';
      const money = priceFormatter(currency, locale);
      const pageProduct = catalogue && context.productHandle
        ? catalogue.products.find((p) => p.handle === context.productHandle) ?? null
        : null;
      const offered = new Set(pageProduct ? [pageProduct.handle] : []);

      // Resolve first: deterministic, from memory, before any model call.
      const byId = (id) => catalogue?.products.find((p) => p.id === id) ?? null;
      let resolution = resolutionIndex
        ? resolveProducts(message, { index: resolutionIndex, pageProductId: pageProduct?.id ?? null, refs, choice })
        : null;
      const resolvedIds = new Set(resolution?.products.map((p) => p.id) ?? []);
      for (const p of resolution?.products ?? []) offered.add(p.handle);
      for (const c of resolution?.candidates ?? []) for (const o of c.options) offered.add(o.handle);
      for (const id of resolution?.range?.ids ?? []) if (byId(id)) offered.add(byId(id).handle);

      const system = buildStorefrontSystemPrompt({
        company,
        context,
        hasTools: Boolean(tools),
        pageProduct: pageProduct && !resolvedIds.has(pageProduct.id) ? productDetail(pageProduct, money) : null,
        resolution: resolution ? describeResolution(resolution, byId, money) : null
      });
      const messages = [...historyMessages(history), { role: 'user', content: message }];
      const trace = { calls: [], tools: [] };
      const usage = { inputTokens: 0, outputTokens: 0 };
      const endsAt = Date.now() + deadlineMs;

      for (let round = 0; ; round += 1) {
        const mustAnswer = !tools || round >= maxToolRounds;
        const remaining = endsAt - Date.now();
        if (remaining <= 0) throw new StorefrontAgentError(`no reply within ${deadlineMs} ms`);

        // Out of tool rounds: say so, or the model answers as if it had found
        // nothing (measured: it hedged « je ne peux pas vérifier » and showed no
        // card after two good searches).
        if (tools && mustAnswer && round > 0) {
          messages.push({ role: 'system', content: FINAL_ROUND_NOTE });
        }

        const started = Date.now();
        let result;
        try {
          result = await withDeadline(
            client.completeWithTools({
              model,
              system,
              messages,
              ...(tools ? { tools, toolChoice: mustAnswer ? 'none' : 'auto' } : {}),
              schema: REPLY_SCHEMA,
              schemaName: 'storefront_reply',
              maxTokens: MAX_REPLY_TOKENS,
              pass: 'storefront_chat'
            }),
            remaining
          );
        } catch (error) {
          throw new StorefrontAgentError(`model call failed: ${error.message}`);
        }
        trace.calls.push(Date.now() - started);
        usage.inputTokens += result?.usage?.prompt_tokens ?? 0;
        usage.outputTokens += result?.usage?.completion_tokens ?? 0;

        const calls = result?.toolCalls ?? [];
        if (!mustAnswer && calls.length > 0) {
          messages.push(result.message);
          for (const call of calls) {
            const ran = call.argsError
              ? { result: { error: `arguments were not valid JSON: ${call.argsError}` }, handles: [] }
              : runTool(call.name, call.args, catalogue, {
                  currency,
                  locale,
                  resolution: { index: resolutionIndex, refs, pageProductId: pageProduct?.id ?? null }
                });
            const { result: output, handles } = ran;
            handles.forEach((h) => offered.add(h));
            // A resolution the model asked for joins the turn's own.
            if (ran.resolution) {
              for (const p of ran.resolution.products) resolvedIds.add(p.id);
              if (!resolution?.clarification && ran.resolution.clarification) resolution = { ...(resolution ?? {}), ...ran.resolution };
            }
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) });
            trace.tools.push({ name: call.name, args: call.args, found: handles.length });
          }
          continue;
        }

        const parsed = parseReply(result?.content);
        const products = toCards(parsed.products, offered, catalogue, money, linkBase);
        const cardIds = products.map((c) => c.id);
        return {
          text: parsed.text,
          products,
          // The clarification's options as chips: from the resolver, never the model.
          choices: resolution?.clarification ? resolution.clarification.options.map((o) => ({ label: o.label, value: o.id ?? o.label })) : [],
          model,
          usage: usage.inputTokens || usage.outputTokens ? usage : null,
          trace,
          // The conversation memory the next turn resolves « les deux », « l'autre » against.
          resolution: resolution
            ? { status: resolution.status, ids: [...resolvedIds], pending: resolution.pending ?? null }
            : null,
          refs: { recommended: cardIds, mentioned: [...new Set([...resolvedIds, ...cardIds])] }
        };
      }
    }
  };
}

/** Earlier turns of THIS session only, oldest first, as the model's own conversation. */
export function historyMessages(history) {
  return history
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_HISTORY_CHARS) }));
}

/** @returns {{ text: string, products: { handle: string, rationale: string }[] }} */
export function parseReply(content) {
  let parsed;
  try {
    parsed = JSON.parse(content ?? '');
  } catch {
    throw new StorefrontAgentError('model reply was not the JSON asked for');
  }
  const text = typeof parsed?.reply === 'string' ? parsed.reply.trim() : '';
  if (!text) throw new StorefrontAgentError('model reply was empty');
  return {
    text: text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS - 1).trimEnd()}…` : text,
    products: Array.isArray(parsed.products) ? parsed.products : []
  };
}

/**
 * Cards for the widget, from the catalogue, never from the model's words: the
 * model contributes a handle and a rationale; name, price and link are ours.
 */
export function toCards(suggested, offered, catalogue, money, linkBase = '') {
  if (!catalogue) return [];
  const seen = new Set();
  const cards = [];
  for (const item of suggested) {
    const handle = typeof item?.handle === 'string' ? item.handle : '';
    if (!offered.has(handle) || seen.has(handle)) continue;
    const product = catalogue.products.find((p) => p.handle === handle);
    if (!product) continue;
    seen.add(handle);
    cards.push({
      id: product.id,
      title: product.name,
      url: `${linkBase}/products/${encodeURIComponent(product.handle)}`,
      image: null,
      price: product.priceFrom === null ? null : money(product.priceFrom),
      rationale: typeof item.rationale === 'string' ? item.rationale.trim().slice(0, MAX_RATIONALE_CHARS) : ''
    });
    if (cards.length === MAX_CARDS) break;
  }
  return cards;
}

/**
 * The resolution as the prompt shows it: the products' facts when resolved, the
 * names when not, the clarification as data. Never more than a handful.
 */
export function describeResolution(resolution, byId, money) {
  return {
    status: resolution.status,
    products: resolution.products.slice(0, 3).map((p) => {
      const product = byId(p.id);
      return product ? { ...productDetail(product, money), resolved_by: p.match_reason } : { id: p.id, name: p.name };
    }),
    candidates: resolution.candidates.map((c) => ({ mention: c.mention, options: c.options.map((o) => ({ id: o.id, name: o.name })) })),
    clarification: resolution.clarification,
    unresolved_mentions: resolution.unresolved_mentions,
    range: resolution.range
      ? { name: resolution.range.name, products: resolution.range.ids.slice(0, 8).map((id) => byId(id)).filter(Boolean).map((p) => ({ id: p.id, name: p.name })) }
      : null
  };
}

/**
 * Where « Découvrir » points. Empty — a same-site path — unless the catalogue
 * lives on another storefront than the widget: the dev store holds a handful
 * of products, the catalogue is production's, so while testing the link goes
 * to the production product page. https origins only; anything else is ignored.
 */
export function productLinkBase(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.origin : '';
  } catch {
    return '';
  }
}

/**
 * Bounded by the wall clock. The fetch timeout should already cut a slow
 * request, but a live request ran 51 s on 2026-10-05 behind Next's patched
 * fetch; the shopper's wait is bounded here whatever the transport does.
 */
export function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no reply within ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** `fetch`, cut after `timeoutMs`. */
export function storefrontFetch(timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch) {
  return (url, init = {}) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/** The client's retry wait, refused: a shopper does not wait out a rate limit. */
export function noRetryWait() {
  return Promise.reject(new Error('not retried on the storefront'));
}

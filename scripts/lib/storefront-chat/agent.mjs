/**
 * storefront_sales_agent — the ONE customer-facing agent behind the storefront
 * advisor. Phase 1: a deterministic mock, proving widget -> proxy -> backend ->
 * widget. Phase 2 swaps in an LLM behind the same `respond` contract; Phase 3
 * gives it read-only tools over a product repository. It never receives SQL,
 * a database handle, or customer / order data.
 *
 * respond({ message, action, context, history }) ->
 *   { text, products: ProductCard[], model: string | null, usage: { inputTokens, outputTokens } | null }
 *
 * ProductCard: { title, url (same-site path), image (https) | null, price | null, rationale }
 */

import { languageOf, messages } from '../i18n/languages.mjs';

export const STOREFRONT_AGENT_NAME = 'storefront_sales_agent';

/**
 * @typedef {object} ProductCard
 * @property {string} title
 * @property {string} url
 * @property {string | null} image
 * @property {string | null} price
 * @property {string} rationale
 *
 * @typedef {object} AgentReply
 * @property {string} text
 * @property {ProductCard[]} products
 * @property {{ label: string, value: string }[]} [choices]  clarification chips, from the resolver
 * @property {string | null} model
 * @property {{ inputTokens: number, outputTokens: number } | null} usage
 * @property {{ calls: number[], tools: { name: string, args: object | null, found: number }[] }} [trace]
 *   LLM agent only: ms per model call, and each tool call with how many products it returned
 */

/** The language of the demo replies (i18n/<code>/messages.mjs, `mock`): the storefront's, English for one the chat does not speak. */
export function replyLanguage(locale) {
  return languageOf(locale);
}

export function createMockAgent() {
  return {
    name: STOREFRONT_AGENT_NAME,
    /**
     * @param {{ message?: string, action?: string | null, context?: { locale?: string | null }, history?: object[] }} [turn]
     * @returns {Promise<AgentReply>}
     */
    async respond({ action = null, context = {} } = {}) {
      const replies = messages(replyLanguage(context.locale)).mock;
      const products = action === 'find_product'
        ? [{ title: replies.product_title, url: '/collections/all', image: null, price: null, rationale: replies.product_rationale }]
        : [];
      return { text: replies[action] ?? replies.default, products, choices: [], model: null, usage: null };
    }
  };
}

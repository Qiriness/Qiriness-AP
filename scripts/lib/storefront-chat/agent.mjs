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

const MOCK_REPLIES = {
  fr: {
    default: 'Merci pour votre message. Ceci est une réponse de démonstration : le conseiller n\'est pas encore connecté.',
    find_product: 'Avec plaisir. Pour vous orienter, dites-m\'en un peu plus sur votre peau : plutôt sèche, mixte, grasse ou sensible ? (Réponse de démonstration.)',
    build_routine: 'Construisons votre routine ensemble. Souhaitez-vous une routine du matin, du soir, ou les deux ? (Réponse de démonstration.)',
    compare: 'Indiquez-moi les soins que vous hésitez à choisir, je vous aiderai à les comparer. (Réponse de démonstration.)',
    delivery_returns: 'Les informations de livraison et de retour seront bientôt disponibles ici. (Réponse de démonstration.)',
    offers: 'Les offres du moment seront bientôt disponibles ici. (Réponse de démonstration.)',
    product_title: 'Exemple de soin',
    product_rationale: 'Carte de démonstration : les vraies suggestions arriveront avec le catalogue.'
  },
  en: {
    default: 'Thank you for your message. This is a demo reply: the advisor is not connected yet.',
    find_product: 'With pleasure. To guide you, tell me a little about your skin: dry, combination, oily or sensitive? (Demo reply.)',
    build_routine: 'Let\'s build your routine together. Would you like a morning routine, an evening routine, or both? (Demo reply.)',
    compare: 'Tell me which products you are hesitating between and I will help you compare them. (Demo reply.)',
    delivery_returns: 'Delivery and returns information will be available here soon. (Demo reply.)',
    offers: 'Current offers will be available here soon. (Demo reply.)',
    product_title: 'Sample product',
    product_rationale: 'Demo card: real suggestions will come with the catalogue.'
  }
};

/** French unless the storefront says English: the brand's storefront is French first. */
export function replyLanguage(locale) {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('en') ? 'en' : 'fr';
}

export function createMockAgent() {
  return {
    name: STOREFRONT_AGENT_NAME,
    /**
     * @param {{ message?: string, action?: string | null, context?: { locale?: string | null }, history?: object[] }} [turn]
     * @returns {Promise<AgentReply>}
     */
    async respond({ action = null, context = {} } = {}) {
      const replies = MOCK_REPLIES[replyLanguage(context.locale)];
      const products = action === 'find_product'
        ? [{ title: replies.product_title, url: '/collections/all', image: null, price: null, rationale: replies.product_rationale }]
        : [];
      return { text: replies[action] ?? replies.default, products, choices: [], model: null, usage: null };
    }
  };
}

import fs from 'node:fs';
import path from 'node:path';

import { loadEnv } from '../lib/sync-config.mjs';
import { createOpenAIClient } from '../../agent/src/llm/openai-client.mjs';
import { DEFAULT_STOREFRONT_MODEL, createLlmAgent } from '../lib/storefront-chat/llm-agent.mjs';
import { advisorStateFromHistory } from '../lib/storefront-chat/advisor-state.mjs';
import { createAdvisor } from '../lib/advisory/recommend.mjs';
import { knowledgeIndex, parseKnowledgeRows } from '../lib/advisory/product-knowledge.mjs';
import { measuredIndex } from '../lib/advisory/replenishment.mjs';
import { buildKnowledge } from '../lib/storefront-chat/knowledge-repository.mjs';

// The routine builder flow (routine-flow.mjs) through the REAL storefront agent
// and model, with no database: the INVENTED sample set (data/advisor/sample/),
// the real playbooks, invented purchases. Nothing real goes to the provider.
//
//   npm run advisor:try-flow                     every scenario, French and English
//   npm run advisor:try-flow -- --only page      one scenario (page, concern, routine, decline, skill, orders, ask_number)
//   npm run advisor:try-flow -- --lang en
//
// Prints both messages of each turn (the reply, then the app's follow-up),
// their cards (« + panier » when the card can add to cart) and buttons.

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const read = (p) => JSON.parse(fs.readFileSync(path.resolve(p), 'utf8'));
const env = loadEnv();

const CONFIG = read('data/advisor/qiriness.json');
const CATALOGUE = read('data/advisor/sample/catalogue.json');
const SHEET = read('data/advisor/sample/knowledge.json');
const { products, errors } = parseKnowledgeRows(SHEET.rows, { concerns: SHEET.concerns });
if (errors.length) throw new Error(`sample knowledge does not import: ${JSON.stringify(errors)}`);
const KNOWLEDGE = knowledgeIndex(products);
const byHandle = (h) => CATALOGUE.products.find((p) => p.handle === h);
const byId = (id) => CATALOGUE.products.find((p) => p.id === id);

// INVENTED orders and policy, for the order status tool: no real order is read.
const workingDaysAgo = (n) => { const d = new Date(); let left = n; while (left > 0) { d.setUTCDate(d.getUTCDate() - 1); if (d.getUTCDay() % 6) left -= 1; } return d.toISOString(); };
const ORDERS = {
  1001: { name: '#1001', processed_at: workingDaysAgo(0), fulfillment_status: 'UNFULFILLED', fulfillments: [], country: 'FR' },
  1002: { name: '#1002', processed_at: workingDaysAgo(6), fulfillment_status: 'UNFULFILLED', fulfillments: [], country: 'FR' },
  1003: { name: '#1003', processed_at: workingDaysAgo(3), fulfillment_status: 'FULFILLED', fulfillments: [{ created_at: workingDaysAgo(1), status: 'SUCCESS' }], country: 'FR' },
  1004: { name: '#1004', processed_at: workingDaysAgo(12), fulfillment_status: 'FULFILLED', fulfillments: [{ created_at: workingDaysAgo(10), status: 'SUCCESS' }], country: 'FR' },
};
const SHOP_KNOWLEDGE = buildKnowledge({
  parameters: [['dispatch_days', '2'], ['france_delivery_days', '3'], ['abroad_delivery_days', '6']].map(([parameter_key, value]) => ({ parameter_key, value })),
  policies: [
    { policy_key: 'dispatch_time_policy', active: true, version: 1, content: 'Les commandes sont préparées sous {dispatch_days} jours ouvrés après réception du paiement.' },
    { policy_key: 'delivery_time_policy', active: true, version: 1, content: 'La livraison prend en général {france_delivery_days} jours ouvrés en France et {abroad_delivery_days} jours ouvrés à l’étranger, à compter de l’expédition.' },
  ],
});

const model = env.STOREFRONT_CHAT_MODEL || DEFAULT_STOREFRONT_MODEL;
const agent = createLlmAgent({
  client: createOpenAIClient({ apiKey: env.OPENAI_API_KEY }),
  model,
  company: { name: 'Qiriness (test)', contactFormPath: '/pages/contact' },
  knowledge: SHOP_KNOWLEDGE,
  readOrder: async ({ orderNumber }) => ORDERS[orderNumber] ?? null,
  orderShopDomain: 'test.myshopify.com',
  catalogue: CATALOGUE,
  advisor: createAdvisor(CONFIG, CATALOGUE, { knowledge: KNOWLEDGE }),
  productKnowledge: KNOWLEDGE,
  repurchaseIntervals: measuredIndex(read('data/advisor/sample/repurchase.json')),
});

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const bought = (handle, days, over = {}) => ({ product_id: byHandle(handle).shopifyId, title: byHandle(handle).name, first_purchased_on: daysAgo(days + 150), last_purchased_on: daysAgo(days), times_purchased: 1, returned: false, free_gift: false, ...over });

// Turns: `say` types a message; `click` picks a button by its value's prefix;
// `auto` answers the consultant's buttons for up to N turns, preferring the
// prefixes in `prefer`, until a routine is recommended.
const SCENARIOS = {
  page: {
    what: 'On a product page (the light cream); signed in, bought a serum. Offer → yes → concern → build around the serum.',
    page: 'test-creme-hydratante-light',
    purchases: [bought('test-serum-hydratant-aqua', 50)],
    prefer: ['profile:body_area:face', 'profile:primary_concern:dehydration', 'purchase:around', 'profile:skin_type:combination'],
    turns: { fr: [{ say: 'Cette crème est-elle adaptée à ma peau ?' }, { click: 'flow:routine:yes' }, { auto: 6 }], en: [{ say: 'Is this cream right for my skin?' }, { click: 'flow:routine:yes' }, { auto: 6 }] },
  },
  concern: {
    what: 'A concern, not signed in. Top pick → offer → typed « oui » → routine around the top pick.',
    purchases: null,
    prefer: ['profile:body_area:face', 'profile:skin_type:dry'],
    turns: { fr: [{ say: 'Que me conseillez-vous pour hydrater mon visage ?' }, { say: 'Oui' }, { auto: 6 }], en: [{ say: 'What do you recommend to hydrate my face?' }, { say: 'Yes' }, { auto: 6 }] },
  },
  routine: {
    what: 'Straight to « build me a routine »; signed in, a daily cream bought twice ~20 weeks ago. Running low → card with add-to-cart.',
    purchases: [bought('test-creme-hydratante-riche', 140, { times_purchased: 2 }), bought('test-masque-hydratant-wrap', 30)],
    prefer: ['profile:body_area:face', 'profile:primary_concern:dehydration', 'purchase:running_low', 'profile:skin_type:dry'],
    turns: { fr: [{ say: 'Pouvez-vous me construire une routine ?' }, { auto: 7 }], en: [{ say: 'Can you build me a routine?' }, { auto: 7 }] },
  },
  skill: {
    what: 'A routine asked for in the customer\'s own words: the model may open the routine builder skill itself.',
    purchases: null,
    turns: { fr: [{ say: 'Mon visage est déshydraté, aidez-moi à tout organiser du matin au soir' }], en: [{ say: 'My face is dehydrated, help me organise everything from morning to night' }] },
  },
  orders: {
    what: 'Invented orders: #1001 placed today, #1002 unshipped for 6 working days, #1004 shipped 10 working days ago; then a 4th lookup (#1003) over the limit.',
    purchases: null,
    turns: {
      fr: [{ say: 'Où en est ma commande #1001 ?' }, { say: 'Et la #1002 ?' }, { say: 'Et la commande 1004 ?' }, { say: 'Et la 1003 ?' }],
      en: [{ say: 'Where is my order #1001?' }, { say: 'And #1002?' }, { say: 'And order 1004?' }, { say: 'And 1003?' }],
    },
  },
  ask_number: {
    what: 'An order question without its number: the AI asks for it (and nothing else), then answers (#1003 shipped yesterday).',
    purchases: null,
    turns: { fr: [{ say: "Je n'ai toujours pas reçu ma commande" }, { say: "C'est la 1003" }], en: [{ say: "I still haven't received my order" }, { say: "It's 1003" }] },
  },
  decline: {
    what: 'A product question, then « non merci » typed: a treat, no second offer.',
    purchases: null,
    turns: { fr: [{ say: 'Parlez-moi du Sérum Hydratant Aqua (test)' }, { say: 'Non merci' }], en: [{ say: 'Tell me about the Sérum Hydratant Aqua (test)' }, { say: 'No thanks' }] },
  },
};

const only = flag('--only');
const langs = flag('--lang') ? [flag('--lang')] : ['fr', 'en'];
const line = (s = '') => console.log(s);
const cards = (list) => list.map((c) => `${c.title}${c.variantId ? ' [+ panier]' : ''}`).join(' | ');
const short = (v) => v.replace(/:[0-9a-f-]{36}$/, ':…');

function show(reply) {
  line(`  ADVISOR   ${reply.text.replace(/\n+/g, '\n            ')}`);
  if (reply.products?.length) line(`  CARDS     ${cards(reply.products)}`);
  if (reply.choices?.length) line(`  BUTTONS   ${reply.choices.map((c) => c.label).join(' | ')}`);
  if (reply.followUp) {
    line(`  ADVISOR²  ${reply.followUp.text}`);
    if (reply.followUp.products.length) line(`  CARDS²    ${cards(reply.followUp.products)}`);
    if (reply.followUp.choices.length) line(`  BUTTONS²  ${reply.followUp.choices.map((c) => c.label).join(' | ')}`);
  }
  const a = reply.trace?.advice;
  if (a?.steps?.length) line(`  ROUTINE   ${a.steps.map((s) => `${s.slot}: ${byId(s.id)?.name}`).join(' · ')}`);
  if (a?.kept?.length) line(`  KEPT      ${a.kept.map((s) => `${s.slot}: ${byId(s.id)?.name} (theirs)`).join(' · ')}`);
  if (a?.pinned?.length) line(`  AROUND    ${a.pinned.map((p) => `${byId(p.id)?.name}: ${p.status}`).join(' · ')}`);
  if (reply.contact) line(`  CONTACT   [Formulaire de contact → ${reply.contact.url}]`);
  const orderTools = (reply.trace?.tools ?? []).filter((t) => t.name === 'get_order_status');
  if (orderTools.length) line(`  ORDER     ${orderTools.map((t) => t.status).join(', ')}`);
  if (reply.trace?.skill_opened) line(`  SKILL     opened by the model: ${reply.trace.skill_opened}`);
  line(`  (mode ${reply.advisor?.mode ?? '—'}, offer ${reply.advisor?.flow?.offer ?? '—'}, follow-up ${reply.trace?.follow_up ?? '—'})`);
}

for (const [key, scenario] of Object.entries(SCENARIOS)) {
  if (only && key !== only) continue;
  for (const lang of langs) {
    line(`\n════ ${key} (${lang}) — ${scenario.what}`);
    const loader = scenario.purchases ? async () => ({ products: scenario.purchases }) : null;
    const context = { locale: lang, ...(scenario.page ? { productHandle: scenario.page } : {}) };
    const history = [];
    let last = null;
    const plan = scenario.turns[lang].flatMap((t) => (t.auto ? Array.from({ length: t.auto }, () => ({ auto: true })) : [t]));
    for (const turn of plan) {
      const buttons = last ? [...(last.followUp?.choices ?? []), ...(last.choices ?? [])] : [];
      if (turn.auto && last?.trace?.advice?.status === 'recommended' && !buttons.length) break;
      let message = turn.say;
      let choice = null;
      if (turn.click || turn.auto) {
        const chip = turn.click
          ? buttons.find((c) => c.value.startsWith(turn.click))
          : (scenario.prefer ?? []).map((p) => buttons.find((c) => c.value.startsWith(p))).find(Boolean) ?? buttons[0];
        if (!chip) { if (turn.click) line(`\n  (no « ${turn.click} » button offered; skipped)`); if (turn.auto) break; continue; }
        message = chip.label;
        choice = chip.value;
      }
      line(`\n  CUSTOMER  ${message}${choice ? `   [${short(choice)}]` : ''}`);
      const started = Date.now();
      try {
        last = await agent.respond({ message, choice, context, history, advisorState: advisorStateFromHistory(history), purchases: loader });
      } catch (error) {
        line(`  ERROR     ${error.message}: the widget would show its fallback reply`);
        break;
      }
      show(last);
      line(`  (${Date.now() - started} ms, ${model})`);
      const stored = last.followUp ? `${last.text}\n\n${last.followUp.text}` : last.text;
      history.push({ role: 'user', content: message }, { role: 'assistant', content: stored, context: { advisor: last.advisor, ...(last.orderLookups ? { order_lookups: last.orderLookups } : {}) } });
    }
  }
}

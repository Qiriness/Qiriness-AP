import fs from 'node:fs';
import path from 'node:path';

import { loadEnv } from '../lib/sync-config.mjs';
import { createOpenAIClient } from '../../agent/src/llm/openai-client.mjs';
import { DEFAULT_STOREFRONT_MODEL, createLlmAgent } from '../lib/storefront-chat/llm-agent.mjs';
import { advisorStateFromHistory } from '../lib/storefront-chat/advisor-state.mjs';
import { createAdvisor } from '../lib/advisory/recommend.mjs';
import { knowledgeIndex, parseKnowledgeRows } from '../lib/advisory/product-knowledge.mjs';
import { buildKnowledge } from '../lib/storefront-chat/knowledge-repository.mjs';

// CUSTOMER SITUATIONS, written from the customer's side (« ma peau tiraille
// après la douche », « c'est au-dessus de ce que je voulais mettre »), not from
// the code's vocabulary. The real agent and model, the INVENTED routines bench
// (data/advisor/sample-routines/) on the foundation engine, invented orders and
// one invented offer; no database. Each situation is judged only on what the
// customer sees: cards, buttons, the follow-up message, the contact link, the
// cart. A failure is a situation the advisor does not yet handle.
//
//   npm run advisor:try-batch                 every situation, FR and EN
//   npm run advisor:try-batch -- --only gift  one situation
//   npm run advisor:try-batch -- --lang fr

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const read = (p) => JSON.parse(fs.readFileSync(path.resolve(p), 'utf8'));
const env = loadEnv();

const CONFIG = read('data/advisor/qiriness.json');
const CATALOGUE = read('data/advisor/sample-routines/catalogue.json');
const SHEET = read('data/advisor/sample-routines/knowledge.json');
const ROUTINES = read('data/advisor/sample-routines/routines.json');
const KNOWLEDGE = knowledgeIndex(parseKnowledgeRows(SHEET.rows, { concerns: SHEET.concerns }).products);
const byId = (id) => CATALOGUE.products.find((p) => p.id === id);
const byHandle = (h) => CATALOGUE.products.find((p) => p.handle === h);
const k = (card) => KNOWLEDGE.get(byId(card.id)?.handle) ?? {};
const concernsOf = (card) => [k(card).primary_concern, ...(k(card).other_concerns ?? [])];

const workingDaysAgo = (n) => { const d = new Date(); let left = n; while (left > 0) { d.setUTCDate(d.getUTCDate() - 1); if (d.getUTCDay() % 6) left -= 1; } return d.toISOString(); };
const ORDERS = { 1004: { name: '#1004', processed_at: workingDaysAgo(12), fulfillment_status: 'FULFILLED', fulfillments: [{ created_at: workingDaysAgo(10), status: 'SUCCESS' }], country: 'FR' } };
const SHOP_KNOWLEDGE = buildKnowledge({
  parameters: [['dispatch_days', '2'], ['france_delivery_days', '3'], ['abroad_delivery_days', '6']].map(([parameter_key, value]) => ({ parameter_key, value })),
  policies: [
    { policy_key: 'dispatch_time_policy', active: true, version: 1, content: 'Les commandes sont préparées sous {dispatch_days} jours ouvrés après réception du paiement.' },
    { policy_key: 'delivery_time_policy', active: true, version: 1, content: 'La livraison prend en général {france_delivery_days} jours ouvrés en France et {abroad_delivery_days} jours ouvrés à l’étranger, à compter de l’expédition.' },
  ],
});
// One invented public offer, on the hydrating serum.
const OFFER = { id: 'offer-1', title: '-15 % sur le Sérum Aqua', codes: [], method: 'automatic', discount_type: 'DiscountAutomaticBasic', status: 'ACTIVE', discount_classes: ['PRODUCT'], describable_in_replies: true, offerable_in_replies: false, starts_at: '2026-01-01T00:00:00Z', ends_at: null, rule_snapshot: { customer_gets: { percentage: 0.15, items: { scope: 'products', products: [{ id: byHandle('t-serum-aqua').shopifyId, title: 'Sérum Hydratant Aqua (test)' }] } } } };

const model = env.STOREFRONT_CHAT_MODEL || DEFAULT_STOREFRONT_MODEL;
const agent = createLlmAgent({
  client: createOpenAIClient({ apiKey: env.OPENAI_API_KEY }),
  model,
  company: { name: 'Qiriness (test)', contactFormPath: '/pages/contact' },
  catalogue: CATALOGUE,
  knowledge: SHOP_KNOWLEDGE,
  advisor: createAdvisor(CONFIG, CATALOGUE, { knowledge: KNOWLEDGE, routines: ROUTINES }),
  productKnowledge: KNOWLEDGE,
  readOrder: async ({ orderNumber }) => ORDERS[orderNumber] ?? null,
  orderShopDomain: 'test.myshopify.com',
  readShopping: async () => ({ status: 'ok', promotions: [OFFER], members: new Map(), products: [], loadedAt: Date.now() }),
});

// What the customer saw in one turn.
const cardsOf = (r) => [...(r.products ?? []), ...(r.followUp?.products ?? [])];
const buttonsOf = (r) => [...(r.choices ?? []), ...(r.followUp?.choices ?? [])];
const asks = (r, prefix) => buttonsOf(r).some((c) => c.value.startsWith(prefix));
const price = (card) => byId(card.id)?.priceFrom ?? Infinity;

// Each situation: turns ({ say } | { click: prefix } | { auto: n } until a routine), then a check on the turns.
const S = {
  tight_skin: {
    what: 'A need in everyday words: our top choices, then the routine offer.',
    turns: { fr: [{ say: "Ma peau tiraille tout le temps, surtout après la douche, qu'est-ce que vous me conseillez ?" }], en: [{ say: 'My skin feels tight all the time, especially after showering, what do you suggest?' }] },
    check: ([r]) => [
      cardsOf(r).length >= 2 || `${cardsOf(r).length} card(s): expected our top choices`,
      cardsOf(r).every((c) => concernsOf(c).some((x) => ['dehydration', 'dryness', 'discomfort'].includes(x))) || 'a card does not target tight / dehydrated skin',
      asks(r, 'flow:routine:') || 'no routine offer',
    ],
  },
  blemish_browse: {
    what: 'Browsing by type for a concern.',
    turns: { fr: [{ say: "Vous avez quelque chose pour mes boutons ? J'en ai surtout sur le menton." }], en: [{ say: "Do you have something for my spots? I mostly get them on my chin." }] },
    check: ([r]) => [
      cardsOf(r).length >= 1 || 'no card',
      cardsOf(r).every((c) => concernsOf(c).some((x) => ['blemishes', 'excess_sebum', 'enlarged_pores', 'uneven_texture'].includes(x))) || 'a card does not target blemishes',
    ],
  },
  compare: {
    what: '« X or Y? »: both named, no routine imposed.',
    turns: { fr: [{ say: 'Entre le Sérum Hydratant Aqua (test) et le Sérum Booster Éclat Énergie (test), lequel me conseillez-vous pour une peau qui manque de peps ?' }], en: [{ say: 'Between the Sérum Hydratant Aqua (test) and the Sérum Booster Éclat Énergie (test), which would you recommend for skin that lacks glow?' }] },
    check: ([r]) => [
      /Aqua/.test(r.text) && /Énergie|Energie/.test(r.text) || 'does not speak of both',
      cardsOf(r).length <= 3 || 'more than 3 cards',
    ],
  },
  too_expensive_soft: {
    what: 'A cream, then the price said softly: a cheaper one of the same type, or a treat.',
    turns: { fr: [{ say: 'Je cherche une crème pour ma peau déshydratée' }, { say: "Hmm, c'est un peu au-dessus de ce que je voulais mettre" }], en: [{ say: "I'm looking for a cream for my dehydrated skin" }, { say: "Hmm, that's a bit more than I wanted to spend" }] },
    check: ([r1, r2]) => {
      // Against the product recommended first, not the cheapest card shown with it.
      const before = price(cardsOf(r1)[0] ?? {});
      const after = cardsOf(r2);
      return [
        after.length >= 1 || 'no card after the price remark',
        after.every((c) => price(c) < before) || `still shows something at ${Math.max(...after.map(price))} € or more (was ${before} €)`,
        !asks(r2, 'flow:routine:') || 'offers a routine after « too expensive »',
      ];
    },
  },
  already_have: {
    what: 'Products they already have are not sold again.',
    turns: { fr: [{ say: "J'ai déjà ma crème et mon démaquillant, que me manque-t-il pour mon visage déshydraté ?" }], en: [{ say: 'I already have my moisturiser and my make-up remover, what am I missing for my dehydrated face?' }] },
    check: ([r]) => [
      cardsOf(r).length >= 1 || 'no card',
      cardsOf(r).every((c) => !['cream', 'cleanser'].includes(k(c).functional_type)) || 'sells a cream or a cleanser again',
    ],
  },
  gift: {
    what: 'A gift, in passing.',
    turns: { fr: [{ say: "C'est pour l'anniversaire de ma sœur, elle adore prendre soin de sa peau" }], en: [{ say: "It's for my sister's birthday, she loves looking after her skin" }] },
    check: ([r]) => [cardsOf(r).some((c) => k(c).gift || k(c).functional_type === 'kit') || 'no gift set among the cards'],
  },
  pamper: {
    what: 'A spa evening without the word spa.',
    turns: { fr: [{ say: 'Ce soir je veux me chouchouter, un vrai moment rien que pour moi' }], en: [{ say: 'Tonight I want to pamper myself, a real moment just for me' }] },
    check: ([r]) => [cardsOf(r).some((c) => ['mask', 'exfoliant', 'kit'].includes(k(c).functional_type)) || 'no mask, scrub or kit'],
  },
  routine_and_cart: {
    what: 'A routine in their words, the routine button, then « Oui, ajouter ».',
    turns: { fr: [{ say: "Aidez-moi à construire une routine, mon visage manque vraiment d'éclat" }, { auto: 6 }, { click: 'flow:cart:yes' }], en: [{ say: 'Help me build a routine, my face really looks dull' }, { auto: 6 }, { click: 'flow:cart:yes' }] },
    check: (rs) => {
      const routine = rs.find((r) => r.routineCart);
      const added = rs.at(-1);
      return [
        Boolean(routine) || 'no « add the routine to my cart » button',
        Boolean(routine && asks(routine, 'flow:cart:')) || 'no « shall I add it to your cart? » question after the routine',
        (added.cart?.add?.length ?? 0) >= 2 || 'nothing added after « Oui, ajouter »',
        added.trace?.model_skipped === 'cart_add' || 'the AI was called for « Oui, ajouter »',
      ];
    },
  },
  single_then_cart: {
    what: 'A product page, the routine offer declined, another product, then « oui » typed to the cart question.',
    page: 't-creme-aqua-light',
    turns: { fr: [{ say: 'Cette crème convient à une peau mixte ?' }, { say: 'Non merci' }, { say: 'Et le Sérum Hydratant Aqua (test), il est comment ?' }, { say: 'Oui, ajoutez-le' }], en: [{ say: 'Does this cream suit combination skin?' }, { say: 'No thanks' }, { say: 'And the Sérum Hydratant Aqua (test), what is it like?' }, { say: 'Yes, add it' }] },
    check: ([, r2, r3, r4]) => [
      cardsOf(r2).some((c) => k(c).treat) || 'no treat after « no thanks »',
      asks(r3, 'flow:cart:') || 'no cart question after the second product',
      /15/.test(r3.text) || 'the serum\'s offer is not mentioned',
      (r4.cart?.add?.length ?? 0) === 1 || 'the typed « yes » did not add it',
    ],
  },
  order_late: {
    what: 'A late order, said with the number.',
    turns: { fr: [{ say: "Bonjour, ma commande 1004 n'est toujours pas arrivée, c'est normal ?" }], en: [{ say: "Hello, my order 1004 still hasn't arrived, is that normal?" }] },
    check: ([r]) => [
      (r.trace?.tools ?? []).some((t) => t.name === 'get_order_status' && t.status === 'delivery_late') || 'the order was not looked up as late',
      /désol|excus|sorry|apolog/i.test(r.text) || 'no apology',
      Boolean(r.contact) || 'no contact link',
    ],
  },
  reaction: {
    what: 'A reaction to a product: customer service, with the link.',
    turns: { fr: [{ say: "J'ai mis la crème hier soir et ce matin j'ai des plaques rouges" }], en: [{ say: 'I put the cream on last night and this morning I have red patches' }] },
    check: ([r]) => [Boolean(r.contact) || 'no contact link', cardsOf(r).length === 0 || 'sells something after a reaction'],
  },
  man_razor: {
    what: 'A man, dry skin, razor irritation, a simple routine.',
    turns: { fr: [{ say: "Je suis un homme, j'ai la peau sèche et le rasage m'irrite, je veux une routine simple" }, { auto: 5 }], en: [{ say: 'I am a man with dry skin and shaving irritates it, I want a simple routine' }, { auto: 5 }] },
    check: (rs) => {
      const routine = [...rs].reverse().find((r) => (r.trace?.advice?.steps?.length ?? 0) >= 2);
      const cards = routine ? cardsOf(routine) : [];
      return [
        Boolean(routine) || 'no routine',
        cards.filter((c) => ['cream', 'cleanser'].includes(k(c).functional_type)).every((c) => k(c).men) || 'a cream or cleanser is not the men\'s one',
      ];
    },
  },
  other_options: {
    what: '« Anything else? » after top choices: different products.',
    turns: { fr: [{ say: 'Que me conseillez-vous pour mon visage terne ?' }, { say: 'Vous avez autre chose ?' }], en: [{ say: 'What do you recommend for my dull face?' }, { say: 'Do you have anything else?' }] },
    check: ([r1, r2]) => {
      const first = new Set(cardsOf(r1).map((c) => c.id));
      return [cardsOf(r2).length >= 1 || 'no card', cardsOf(r2).some((c) => !first.has(c.id)) || 'only the same products again'];
    },
  },
};

const only = flag('--only');
const langs = flag('--lang') ? [flag('--lang')] : ['fr', 'en'];
const line = (s = '') => console.log(s);
const results = [];

for (const [key, s] of Object.entries(S)) {
  if (only && key !== only) continue;
  for (const lang of langs) {
    line(`\n════ ${key} (${lang}) — ${s.what}`);
    const context = { locale: lang, ...(s.page ? { productHandle: s.page } : {}) };
    const history = [];
    const replies = [];
    let last = null;
    const plan = s.turns[lang].flatMap((t) => (t.auto ? Array.from({ length: t.auto }, () => ({ auto: true })) : [t]));
    for (const turn of plan) {
      const buttons = last ? buttonsOf(last) : [];
      if (turn.auto && (last?.routineCart || !buttons.length || buttons.some((b) => b.value.startsWith('flow:cart:')))) continue;
      let message = turn.say;
      let choice = null;
      if (turn.click || turn.auto) {
        const chip = turn.click ? buttons.find((c) => c.value.startsWith(turn.click)) : buttons.find((c) => c.value.startsWith('profile:')) ?? buttons[0];
        if (!chip) { line(`  (no « ${turn.click ?? 'answer'} » button)`); continue; }
        message = chip.label;
        choice = chip.value;
      }
      line(`  CUSTOMER  ${message}`);
      try {
        last = await agent.respond({ message, choice, context, history, advisorState: advisorStateFromHistory(history), shopDomain: 'test.myshopify.com' });
      } catch (error) {
        line(`  ERROR     ${error.message}`);
        break;
      }
      replies.push(last);
      line(`  ADVISOR   ${last.text.replace(/\n+/g, ' ')}`);
      if (cardsOf(last).length) line(`  CARDS     ${cardsOf(last).map((c) => `${c.title} ${byId(c.id)?.priceFrom ?? ''}€`).join(' | ')}`);
      if (last.followUp) line(`  ADVISOR²  ${last.followUp.text}`);
      if (buttonsOf(last).length) line(`  BUTTONS   ${buttonsOf(last).map((c) => c.label).join(' | ')}`);
      if (last.routineCart) line(`  [Ajouter la routine au panier: ${last.routineCart.add.length} produits]`);
      if (last.cart) line(`  [widget adds ${last.cart.add.length} to the cart]`);
      if (last.contact) line(`  [Formulaire de contact]`);
      const stored = last.followUp ? `${last.text}\n\n${last.followUp.text}` : last.text;
      history.push({ role: 'user', content: message }, { role: 'assistant', content: stored, context: { advisor: last.advisor, ...(last.orderLookups ? { order_lookups: last.orderLookups } : {}) } });
    }
    const fails = replies.length ? s.check(replies).filter((x) => x !== true) : ['no reply'];
    results.push({ id: `${key}.${lang}`, pass: !fails.length, fails });
    line(fails.length ? `  ✗ ${fails.join('\n  ✗ ')}` : '  ✓ as expected');
  }
}
line(`\n${results.filter((r) => r.pass).length}/${results.length} situations as expected (${model}).`);
for (const r of results.filter((x) => !x.pass)) line(`  FAIL ${r.id}: ${r.fails.join('; ')}`);
if (flag('--json')) fs.writeFileSync(path.resolve(flag('--json')), `${JSON.stringify({ at: new Date().toISOString(), model, results }, null, 2)}\n`);

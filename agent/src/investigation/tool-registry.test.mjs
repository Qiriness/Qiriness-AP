import assert from 'node:assert/strict';
import test from 'node:test';

import { REQUEST_KINDS, TICKET_SUBJECTS } from '../../../scripts/lib/support-taxonomy.mjs';
import { CAVEAT_CODES } from './case-file.mjs';
import { TOOL_NAMES, allowedTools } from './investigation-rules.mjs';
import { TOOL_DEFINITIONS, createToolRegistry } from './tool-registry.mjs';

function buildRegistry(overrides = {}) {
  return createToolRegistry({
    shopId: 's1',
    customerLookup: {
      async lookupCustomer() {
        return { found: true, matchedBy: 'email_hash', customerId: 'c1', promptText: '# Client : Marie' };
      }
    },
    productLookup: {
      async lookupProduct() {
        return { found: true, ambiguous: false, promptText: '# Masque LED' };
      },
      async resolveProductRef() {
        return { found: true, ambiguous: false, title: 'Masque LED', shopifyProductId: 'gid://shopify/Product/1' };
      },
      async lookupStock() {
        return { found: true, ambiguous: false, products: [{ title: 'Masque LED', purchasable: true }] };
      },
      async crossSellFor() {
        return { found: true, source: 'Masque LED', products: [{ title: 'Crème Source d’Eau', summary: null }] };
      },
      async recommendedFor() {
        return [{ title: 'Crème Apaisante', summary: null, concerns: ['sensitive'] }];
      }
    },
    promotionLookup: {
      async extractCodes() {
        return ['BIENVENUE10'];
      },
      async lookupPromotion() {
        return {
          found: true,
          code: 'BIENVENUE10',
          eligibility: { verdict: 'undetermined', blocking: [], unknowns: ['minimum d’achat'] },
          promptText: '# Code BIENVENUE10'
        };
      },
      async offersForProduct() {
        return { specific: [{ code: 'UKLED20', title: 'LED', summary: '20% off' }], general: [] };
      },
      async listActive() {
        // Shape changed when listActive stopped answering per redeem code:
        // { promotions, total, truncated } rather than a bare array.
        return {
          promotions: [{ code: 'BIENVENUE10', title: 'Bienvenue', codeCount: 1 }],
          total: 1,
          truncated: false
        };
      }
    },
    purchaseLookup: {
      async verify() {
        return {
          state: 'known_buyer',
          verified: true,
          lastOrder: { name: '#6788', products: [{ title: 'Masque LED' }] },
          product: { verdict: 'in_last_order', matched: 'Masque LED' }
        };
      },
      toPromptText() {
        return 'Client identifié : oui, avec au moins une commande en ligne.';
      }
    },
    async retrieveKnowledge() {
      return { verdict: 'answerable', bestSimilarity: 0.72, chunks: [{ title: 'FAQ', text: 'texte' }] };
    },
    ...overrides
  });
}

const PRODUCT_TICKET = {
  category: 'product',
  request_kind: 'question',
  level: 1,
  subject: 'Masque LED',
  text: 'le masque LED convient-il aux peaux sensibles ?'
};

test('every tool the policy can name has a definition and a handler', () => {
  // A policy entry with no implementation would hand the model a function that
  // does not exist.
  const registry = buildRegistry();
  const named = new Set();
  for (const subject of TICKET_SUBJECTS) {
    for (const kind of REQUEST_KINDS) {
      for (const name of allowedTools(subject, kind, 2)) {
        named.add(name);
      }
    }
  }

  for (const name of named) {
    assert.ok(TOOL_DEFINITIONS[name], `${name} has no definition`);
  }
  const { names } = registry.toolsFor({ category: 'product', request_kind: 'question', level: 1 });
  assert.ok(names.length > 0);
});

test('the registry hands over exactly what the policy allows', () => {
  const registry = buildRegistry();
  const { names, definitions } = registry.toolsFor(PRODUCT_TICKET);

  assert.deepEqual(names, allowedTools('product', 'question', 1));
  assert.deepEqual(definitions.map((d) => d.function.name), names);
  assert.ok(!names.includes(TOOL_NAMES.LOOKUP_PROMOTION));
});

test('a level 4 ticket gets no tools at all', () => {
  const registry = buildRegistry();
  const { names, definitions } = registry.toolsFor({ ...PRODUCT_TICKET, level: 4 });

  assert.deepEqual(names, []);
  assert.deepEqual(definitions, []);
});

test('every tool definition is a valid strict function schema', () => {
  const registry = buildRegistry();
  const { definitions } = registry.toolsFor({ category: 'promotions', request_kind: 'problem', level: 2 });

  for (const def of definitions) {
    assert.equal(def.type, 'function');
    assert.ok(def.function.description.length > 20, `${def.function.name} needs a real description`);
    assert.equal(def.function.parameters.type, 'object');
    assert.equal(def.function.parameters.additionalProperties, false);
    assert.ok(Array.isArray(def.function.parameters.required));
  }
});

test('a promotion lookup always carries the basket prohibition', async () => {
  // There are no cart tables and the Admin API exposes no in-progress cart, so
  // this is structural rather than case-by-case.
  const registry = buildRegistry();
  const { handlers } = registry.toolsFor({ category: 'promotions', request_kind: 'problem', level: 2 });

  const result = await handlers.get(TOOL_NAMES.LOOKUP_PROMOTION)({ code: 'BIENVENUE10' });
  assert.ok(result.caveats.includes('basket_unseeable'));
  assert.ok(result.caveats.includes('eligibility_undetermined'));
  assert.equal(result.outcome, 'undetermined');
});

test('an eligible promotion drops the eligibility caveat but keeps the basket one', async () => {
  const registry = buildRegistry({
    promotionLookup: {
      async extractCodes() {
        return [];
      },
      async lookupPromotion() {
        return { found: true, code: 'X', eligibility: { verdict: 'eligible', blocking: [], unknowns: [] }, promptText: 'x' };
      },
      async offersForProduct() {
        return { specific: [{ code: 'UKLED20', title: 'LED', summary: '20% off' }], general: [] };
      },
      async listActive() {
        return { promotions: [], total: 0, truncated: false };
      }
    }
  });
  const { handlers } = registry.toolsFor({ category: 'promotions', request_kind: 'problem', level: 2 });

  const result = await handlers.get(TOOL_NAMES.LOOKUP_PROMOTION)({ code: 'X' });
  // The limits prohibition rides on every promotion answer, eligible or not:
  // "no expiry, no usage limit" is operational, and a reply that repeats it
  // promises something the shop never offered (ticket 1f8b4f0a).
  assert.deepEqual(result.caveats, ['basket_unseeable', 'promotion_limits_internal']);
});

test('a promotion answer never states the absence of a limit', async () => {
  const registry = buildRegistry({
    promotionLookup: {
      async extractCodes() {
        return [];
      },
      async lookupPromotion() {
        return { found: true, code: 'X', eligibility: { verdict: 'eligible', blocking: [], unknowns: [] }, promptText: 'x' };
      },
      async offersForProduct() {
        return { specific: [{ code: 'UKLED20', title: 'LED', summary: '20% off' }], general: [] };
      },
      async listActive() {
        return { promotions: [{ code: 'BIENVENUE', title: 'Bienvenue', summary: '-20%' }], total: 1, truncated: false };
      }
    }
  });
  const { handlers } = registry.toolsFor({ category: 'promotions', request_kind: 'problem', level: 2 });

  for (const tool of [TOOL_NAMES.LIST_ACTIVE_PROMOTIONS, TOOL_NAMES.LOOKUP_PROMOTION]) {
    const result = await handlers.get(tool)(tool === TOOL_NAMES.LOOKUP_PROMOTION ? { code: 'X' } : {});
    assert.ok(result.caveats.includes('promotion_limits_internal'), tool);
  }
});

test('weak knowledge is reported but its text is withheld', async () => {
  // Showing a model text it is told not to use is a temptation with no upside.
  const registry = buildRegistry({
    async retrieveKnowledge() {
      return { verdict: 'weak', bestSimilarity: 0.51, chunks: [{ title: 'CGV', text: 'texte contractuel' }] };
    }
  });
  const { handlers } = registry.toolsFor(PRODUCT_TICKET);

  const result = await handlers.get(TOOL_NAMES.SEARCH_KNOWLEDGE)({});
  assert.deepEqual(result.caveats, ['knowledge_weak']);
  assert.ok(!result.promptText.includes('texte contractuel'));
  assert.deepEqual(result.data.chunks, []);
});

test('an unmatched customer raises the customer_unknown caveat', async () => {
  const registry = buildRegistry({
    customerLookup: {
      async lookupCustomer() {
        return { found: false, reason: 'no_match', customerId: null, promptText: 'Aucun compte client…' };
      }
    }
  });
  const { handlers } = registry.toolsFor({ category: 'account', request_kind: 'problem', level: 2 });

  const result = await handlers.get(TOOL_NAMES.LOOKUP_CUSTOMER)({});
  assert.deepEqual(result.caveats, ['customer_unknown']);
  assert.equal(result.outcome, 'no_match');
});

test('on an anonymous marketplace order, an unmatched customer is not a question for the customer', async () => {
  // Ticket #6059: the no-match text told the model to ask which address the
  // account is under, and the case file asked an Amazon buyer for it.
  const unmatched = {
    customerLookup: {
      async lookupCustomer() {
        return {
          found: false,
          reason: 'no_match',
          customerId: null,
          promptText: 'Le client peut être enregistré sous une AUTRE adresse — c’est la question à lui poser.'
        };
      }
    }
  };
  const ticket = { category: 'delivery', request_kind: 'problem', level: 3 };

  const anonymous = buildRegistry(unmatched).toolsFor({ ...ticket, orderBuyerAnonymous: true });
  const quiet = await anonymous.handlers.get(TOOL_NAMES.LOOKUP_CUSTOMER)({});
  assert.equal(quiet.outcome, 'no_match', 'the finding itself is unchanged');
  assert.deepEqual(quiet.caveats, ['customer_unknown']);
  assert.ok(!quiet.promptText.includes('question à lui poser'));
  assert.ok(quiet.promptText.includes('Ne demander aucune adresse'));

  const ordinary = buildRegistry(unmatched).toolsFor(ticket);
  const asks = await ordinary.handlers.get(TOOL_NAMES.LOOKUP_CUSTOMER)({});
  assert.ok(asks.promptText.includes('question à lui poser'), 'every other ticket keeps the question');
});

test('an ambiguous product is a caveat, never a silent pick', async () => {
  const registry = buildRegistry({
    productLookup: {
      async lookupProduct() {
        return { found: true, ambiguous: true, promptText: 'Attention : deux produits…' };
      },
      async resolveProductRef() {
        return { found: true, ambiguous: false, title: 'Masque LED', shopifyProductId: 'gid://shopify/Product/1' };
      },
      async lookupStock() {
        return { found: false };
      }
    }
  });
  const { handlers } = registry.toolsFor(PRODUCT_TICKET);

  const product = await handlers.get(TOOL_NAMES.LOOKUP_PRODUCT)({ question: 'le coffret' });
  assert.deepEqual(product.caveats, ['product_ambiguous']);

  const stock = await handlers.get(TOOL_NAMES.LOOKUP_STOCK)({ question: 'le coffret' });
  assert.deepEqual(stock.caveats, ['stock_unknown']);
});

test('an unresolved order reports itself rather than assembling a bundle', async () => {
  const registry = buildRegistry();
  const { handlers } = registry.toolsFor({ category: 'delivery', request_kind: 'problem', level: 2 });

  const result = await handlers.get(TOOL_NAMES.GET_ORDER_CONTEXT)({});
  assert.equal(result.outcome, 'not_resolved');
  assert.deepEqual(result.caveats, ['order_unconfirmed']);
});

test('every caveat the registry can emit is one case-file knows how to render', async () => {
  const registry = buildRegistry();
  const emitted = new Set();
  const collect = async (ticket, args = {}) => {
    const { handlers } = registry.toolsFor(ticket);
    for (const [, handler] of handlers) {
      const result = await handler(args);
      for (const caveat of result.caveats) emitted.add(caveat);
    }
  };

  await collect({ category: 'promotions', request_kind: 'problem', level: 2, text: 'x' }, { code: 'X' });
  await collect({ category: 'delivery', request_kind: 'problem', level: 2, text: 'x' });

  for (const caveat of emitted) {
    assert.ok(CAVEAT_CODES.includes(caveat), `${caveat} is not a known caveat code`);
  }
});

test('the model is shown the tool rendering, never a raw row', async () => {
  const registry = buildRegistry();
  const { handlers } = registry.toolsFor({ category: 'account', request_kind: 'problem', level: 2 });

  const result = await handlers.get(TOOL_NAMES.LOOKUP_CUSTOMER)({});
  assert.equal(result.promptText, '# Client : Marie');
  // The row id lives in `data` for the runner, and is not part of what the model reads.
  assert.equal(result.data.customerId, 'c1');
  assert.ok(!result.promptText.includes('c1'));
});

test('no tool hands the model a serialised structure', async () => {
  // THE GENERAL FORM OF A REAL BUG. `getOrderContext` returned
  // `JSON.stringify(context.order)` because the rendering it asks for was never
  // written — so nobody had decided what the agent is told about an order, and
  // every field later added to the bundle would have reached the prompt too.
  //
  // `promptText` is the withhold boundary: it is prose somebody chose, and a
  // serialised object is the absence of that choice. This asserts the property
  // for every tool at once, so the next one cannot reintroduce it.
  const registry = buildRegistry();
  const seen = [];
  const collect = async (ticket, args = {}) => {
    const { handlers } = registry.toolsFor(ticket);
    for (const [name, handler] of handlers) {
      const { promptText } = await handler(args);
      seen.push([name, promptText]);
    }
  };

  await collect({ category: 'promotions', request_kind: 'problem', level: 2, text: 'x' }, { code: 'X' });
  await collect({ category: 'product', request_kind: 'question', level: 2, text: 'x' }, { question: 'x' });
  await collect({ category: 'delivery', request_kind: 'problem', level: 2, text: 'x' });
  await collect({ category: 'account', request_kind: 'problem', level: 2, text: 'x' });

  for (const [name, promptText] of seen) {
    assert.equal(typeof promptText, 'string', `${name} returned no promptText`);
    const head = promptText.trimStart()[0];
    assert.ok(head !== '{' && head !== '[', `${name} handed the model serialised JSON`);
  }
});

// --- a tool argument that quotes the customer must be the customer's words ----

test('a code the customer never wrote is refused, not looked up', async () => {
  // MEASURED. On a product ticket the model called lookupPromotion with
  // `MASQUELEDVISAGE` — « votre Masque LED visage » run together. The message
  // held no all-caps run at all, so extraction had correctly found nothing; the
  // argument was composed. The lookup then reported `not_found`, which
  // evidence-rules recorded as promotion_validity SATISFIED: a settled finding
  // about a code nobody quoted.
  const registry = buildRegistry({
    promotionLookup: {
      async lookupPromotion() {
        // The shop has no such code — which is the only case the guard rewrites.
        return { found: false, code: null, promptText: 'x' };
      },
      async extractCodes() {
        return [];
      },
      async offersForProduct() {
        return { specific: [{ code: 'UKLED20', title: 'LED', summary: '20% off' }], general: [] };
      },
      async listActive() {
        return { promotions: [], total: 0, truncated: false };
      }
    }
  });
  const { handlers } = registry.toolsFor({
    category: 'promotions',
    request_kind: 'problem',
    level: 2,
    text: 'Je m’intéresse à votre Masque LED visage'
  });

  const result = await handlers.get(TOOL_NAMES.LOOKUP_PROMOTION)({ code: 'MASQUELEDVISAGE' });

  assert.equal(result.outcome, 'no_code_in_message');
  assert.equal(result.data.code, null, 'nothing for a finding to settle on');
  assert.equal(result.data.rejected, 'MASQUELEDVISAGE', 'but what was refused is recorded');
});

test('a typo the customer typed still gets the ordinary not-found answer', async () => {
  // The guard must not swallow a real mistake: `QIRINES20` is in the message, so
  // the customer wants to know why it fails — suggestions and all.
  const registry = buildRegistry({
    promotionLookup: {
      async lookupPromotion() {
        return { found: false, code: null, promptText: 'Le code n’existe pas. Voulez-vous dire QIRINESS20 ?' };
      },
      async extractCodes() { return []; },
      async offersForProduct() {
        return { specific: [{ code: 'UKLED20', title: 'LED', summary: '20% off' }], general: [] };
      },
      async listActive() { return { promotions: [], total: 0, truncated: false }; }
    }
  });
  const { handlers } = registry.toolsFor({
    category: 'promotions', request_kind: 'problem', level: 2,
    text: 'mon code QIRINES20 est refusé'
  });

  const result = await handlers.get(TOOL_NAMES.LOOKUP_PROMOTION)({ code: 'QIRINES20' });
  assert.equal(result.outcome, 'not_found', 'not swallowed by the guard');
});

test('a code the customer DID write is looked up, punctuation and case aside', async () => {
  // A customer writes `qiriness-20` for QIRINESS20. Refusing that would send the
  // agent asking for a code it had already been given.
  const seen = [];
  const registry = buildRegistry({
    promotionLookup: {
      async lookupPromotion(code) {
        seen.push(code);
        return { found: true, code, eligibility: { verdict: 'eligible', checks: [] }, promptText: 'ok' };
      },
      async extractCodes() {
        return [];
      },
      async offersForProduct() {
        return { specific: [{ code: 'UKLED20', title: 'LED', summary: '20% off' }], general: [] };
      },
      async listActive() {
        return { promotions: [], total: 0, truncated: false };
      }
    }
  });
  const { handlers } = registry.toolsFor({
    category: 'promotions',
    request_kind: 'problem',
    level: 2,
    text: 'mon code qiriness-20 ne marche pas'
  });

  const result = await handlers.get(TOOL_NAMES.LOOKUP_PROMOTION)({ code: 'QIRINESS20' });

  assert.deepEqual(seen, ['QIRINESS20']);
  assert.equal(result.outcome, 'eligible');
});

// --- the abandoned checkout, the only view we get of a basket -----------------

const ORDER_TICKET = {
  category: 'order',
  request_kind: 'problem',
  level: 2,
  subject: 'Le masque offert',
  text: 'le masque offert ne s’ajoute pas à mon panier'
};

const CHECKOUT = {
  id: 'gid://shopify/AbandonedCheckout/1',
  name: '#C1',
  createdAt: '2026-09-12T08:00:00Z',
  updatedAt: '2026-09-12T08:20:00Z',
  recoveryUrl: 'https://qiriness.com/checkouts/abc/recover?key=secret',
  email: 'marie@example.com',
  customerId: 'gid://shopify/Customer/1',
  discountCodes: ['QIRINESS20'],
  subtotal: 219.87,
  total: 219.87,
  totalDiscount: 24.43,
  subtotalBeforeDiscount: 244.3,
  currency: 'EUR',
  lineItems: [
    { title: 'Masque LED', variantTitle: null, quantity: 1, productTitle: 'Masque LED' },
    { title: 'Crème', variantTitle: '50 ml', quantity: 2, productTitle: 'Crème Source d’Eau' }
  ]
};

/** A registry whose customer resolves to an address, with a stubbed basket. */
function buildCheckoutRegistry({ checkout = CHECKOUT, found = true, reason = null, customerEmail = 'marie@example.com' } = {}) {
  const calls = [];
  const registry = buildRegistry({
    customerLookup: {
      async lookupCustomer() {
        return customerEmail
          ? { found: true, customerId: 'c1', customer: { name: 'Marie', email: customerEmail }, promptText: '# Client' }
          : { found: false, reason: 'no_match', customer: null, promptText: '# Inconnu' };
      }
    },
    async checkoutLookup(args) {
      calls.push(args);
      return found ? { found: true, checkout } : { found: false, reason, checkout: null };
    }
  });
  return { registry, calls };
}

test('the order and promotions subjects can look in a basket; product cannot', () => {
  const { registry } = buildCheckoutRegistry();
  const namesFor = (ticket) => registry.toolsFor(ticket).names;

  assert.ok(namesFor(ORDER_TICKET).includes(TOOL_NAMES.LOOKUP_ABANDONED_CHECKOUT));
  assert.ok(
    namesFor({ category: 'promotions', request_kind: 'problem', level: 2 }).includes(
      TOOL_NAMES.LOOKUP_ABANDONED_CHECKOUT
    )
  );
  // A product question has no basket in it, and the tool reads live Shopify.
  assert.ok(!namesFor(PRODUCT_TICKET).includes(TOOL_NAMES.LOOKUP_ABANDONED_CHECKOUT));
});

test('without Shopify credentials the basket tool is not offered at all', () => {
  // Rather than bound and throwing on call: the model must never be handed a
  // function that fails for a reason about our wiring.
  const registry = buildRegistry();
  assert.ok(!registry.toolsFor(ORDER_TICKET).names.includes(TOOL_NAMES.LOOKUP_ABANDONED_CHECKOUT));
});

test('the model never chooses whose basket to open', () => {
  // The ticket carries a hash, not an address. An `email` parameter would be the
  // model naming a customer on a string it composed.
  assert.deepEqual(TOOL_DEFINITIONS[TOOL_NAMES.LOOKUP_ABANDONED_CHECKOUT].parameters.properties, {});
  assert.deepEqual(TOOL_DEFINITIONS[TOOL_NAMES.LOOKUP_ABANDONED_CHECKOUT].parameters.required, []);
});

test('a retrieved basket is dated, itemised, and still carries the basket caveat', async () => {
  const { registry, calls } = buildCheckoutRegistry();
  const { handlers } = registry.toolsFor(ORDER_TICKET);
  const result = await handlers.get(TOOL_NAMES.LOOKUP_ABANDONED_CHECKOUT)();

  assert.equal(result.outcome, 'found');
  assert.equal(calls[0].email, 'marie@example.com', 'looked up by the resolved customer');
  assert.ok(calls[0].since instanceof Date);

  // Dated from `updatedAt`, which is when the basket was actually true.
  assert.match(result.promptText, /2026-09-12/);
  assert.match(result.promptText, /1 × Masque LED/);
  assert.match(result.promptText, /2 × Crème Source d’Eau \(50 ml\)/);
  // Before discount: the number a minimum requirement is measured against.
  assert.match(result.promptText, /244\.3 EUR/);
  assert.match(result.promptText, /QIRINESS20/);

  // THE CAVEAT SURVIVES A HIT. What came back is the basket they LEFT, not the
  // one they are looking at, and `draft-checks` flags « votre panier contient ».
  assert.ok(result.caveats.includes('basket_unseeable'));
});

test('neither the recovery link nor the address reaches the model or the case file', async () => {
  // `abandonedCheckoutUrl` opens that basket in the customer's own session.
  const { registry } = buildCheckoutRegistry();
  const { handlers } = registry.toolsFor(ORDER_TICKET);
  const result = await handlers.get(TOOL_NAMES.LOOKUP_ABANDONED_CHECKOUT)();

  const everything = JSON.stringify([result.promptText, result.data]);
  assert.ok(!everything.includes('recover?key=secret'), 'recovery link leaked');
  assert.ok(!everything.includes('marie@example.com'), 'address leaked');
});

test('a customer we could not identify is not a customer with no basket', async () => {
  const { registry, calls } = buildCheckoutRegistry({ customerEmail: null });
  const { handlers } = registry.toolsFor(ORDER_TICKET);
  const result = await handlers.get(TOOL_NAMES.LOOKUP_ABANDONED_CHECKOUT)();

  assert.equal(result.outcome, 'no_customer');
  assert.equal(calls.length, 0, 'nothing was searched');
  assert.ok(result.caveats.includes('customer_unknown'));
});

test('a miss keeps the reason, because the two misses are different facts', async () => {
  for (const reason of ['none_in_window', 'no_match']) {
    const { registry } = buildCheckoutRegistry({ found: false, reason });
    const { handlers } = registry.toolsFor(ORDER_TICKET);
    const result = await handlers.get(TOOL_NAMES.LOOKUP_ABANDONED_CHECKOUT)();
    assert.equal(result.outcome, reason);
    // Shopify only records a basket once an email was entered, so a miss is not
    // proof the customer's basket was empty. The prompt has to say so.
    assert.match(result.promptText, /ne pas en conclure/i);
  }
});

// --- advice from activated collections -----------------------------------------

const ADVICE_TICKET = {
  category: 'product',
  request_kind: 'question',
  level: 1,
  subject: 'conseil',
  text: 'Avez-vous l’équivalence d’un sérum anti-rides ?'
};

const SERUMS = { handle: 'serums-visage', title: 'Sérums Visage', axis: 'category', productIds: ['gid/1', 'gid/2'] };
const RIDES = {
  handle: 'diag-rides-et-ridules',
  title: 'Diag - Rides et ridules',
  axis: 'concern',
  productIds: ['gid/2', 'gid/3']
};

function buildAdviceRegistry(active = [SERUMS, RIDES]) {
  return buildRegistry({
    adviceCollections: {
      async active() {
        return active;
      },
      cached() {
        return active;
      }
    },
    productLookup: {
      async lookupProduct() {
        return { found: false, ambiguous: false, products: [], candidates: [] };
      },
      async crossSellFor() {
        return { found: false, source: null, products: [] };
      },
      async recommendedFor() {
        return [];
      },
      async detailsByShopifyIds(ids) {
        const catalogue = {
          'gid/1': { title: 'Sérum Éclat', summary: 'Ravive le teint.', tags: ['peaux ternes'] },
          'gid/2': { title: 'Sérum Anti-âge Liftant', summary: 'Lisse les rides.', tags: ['peaux matures'] },
          'gid/3': { title: 'Crème Anti-âge', summary: 'Nourrit.', tags: [] }
        };
        return ids.map((id) => ({ shopifyProductId: id, ...catalogue[id] })).filter((p) => p.title);
      }
    }
  });
}

test('the model is shown the activated collections, and only those', () => {
  // The guard that makes a model-supplied argument safe: it picks from a list it
  // was given, rather than inventing a category the team never switched on.
  const registry = buildAdviceRegistry();
  const { definitions } = registry.toolsFor(ADVICE_TICKET);
  const recommend = definitions.find((d) => d.function.name === TOOL_NAMES.RECOMMEND_PRODUCTS);

  assert.match(recommend.function.description, /Valeurs autorisées pour requirements/);
  assert.match(recommend.function.description, /Diag - Rides et ridules/);
  assert.match(recommend.function.description, /Sérums Visage/);
  assert.ok(recommend.function.parameters.properties.requirements, 'no requirements argument');
});

test('with nothing activated the tool reads exactly as it did before', () => {
  // A shop that has curated nothing keeps the concern path it already had.
  const registry = buildAdviceRegistry([]);
  const { definitions } = registry.toolsFor(ADVICE_TICKET);
  const recommend = definitions.find((d) => d.function.name === TOOL_NAMES.RECOMMEND_PRODUCTS);
  assert.doesNotMatch(recommend.function.description, /Valeurs autorisées/);
});

test('products in every named collection come back as by_collection', async () => {
  const registry = buildAdviceRegistry();
  const { handlers } = registry.toolsFor(ADVICE_TICKET);
  const result = await handlers.get(TOOL_NAMES.RECOMMEND_PRODUCTS)({
    product: null,
    requirements: ['Sérums Visage', 'Diag - Rides et ridules']
  });

  assert.equal(result.outcome, 'by_collection');
  assert.deepEqual(result.data.titles, ['Sérum Anti-âge Liftant']);
  assert.deepEqual(result.data.dropped, []);
  // The reply shape: name, what it does, who it suits — not three bare names.
  assert.match(result.promptText, /- Sérum Anti-âge Liftant — Lisse les rides\. Pour peau mature\./);
});

test('a requirement given up is its own outcome and is said out loud', async () => {
  // `relaxed` rather than a flag inside `data`: a rule branches on the outcome,
  // and « pour les rides, en sérum » is a different sentence from a full match.
  const impossible = { handle: 'diag-taches', title: 'Diag - Taches', axis: 'concern', productIds: ['gid/9'] };
  const registry = buildAdviceRegistry([SERUMS, RIDES, impossible]);
  const { handlers } = registry.toolsFor(ADVICE_TICKET);
  const result = await handlers.get(TOOL_NAMES.RECOMMEND_PRODUCTS)({
    product: null,
    requirements: ['Sérums Visage', 'Diag - Rides et ridules', 'Diag - Taches']
  });

  assert.equal(result.outcome, 'relaxed');
  assert.deepEqual(result.data.dropped, ['diag-taches']);
  assert.match(result.promptText, /NE PAS laisser entendre/);
  assert.match(result.promptText, /Diag - Taches/);
});

test('a requirement nobody curated is reported, not silently answered', async () => {
  const registry = buildAdviceRegistry();
  const { handlers } = registry.toolsFor(ADVICE_TICKET);
  const result = await handlers.get(TOOL_NAMES.RECOMMEND_PRODUCTS)({
    product: null,
    requirements: ['Sérums Visage', 'Soins Solaires']
  });

  assert.deepEqual(result.data.unknown, ['Soins Solaires']);
  assert.match(result.promptText, /n'a rien de sélectionné pour : Soins Solaires/);
});

test('the type of care is read from the message even when the model forgets it', async () => {
  // THE REGRESSION THIS EXISTS FOR, measured on a real run: « je voudrais un
  // sérum … peau sensible … des rides » came back from the model as two
  // concerns and no serum, and the reply offered a sunscreen, a cream and a
  // mist. The word « sérum » is in the customer's own message; reading it is
  // not a judgement.
  const registry = buildAdviceRegistry();
  const { handlers } = registry.toolsFor(ADVICE_TICKET);
  const result = await handlers.get(TOOL_NAMES.RECOMMEND_PRODUCTS)({ product: null, requirements: [] });

  assert.equal(result.outcome, 'by_collection');
  assert.deepEqual(result.data.fromCues, ['serums-visage']);
  assert.ok(result.data.titles.length > 0, 'nothing was put forward');
});

test('a message naming no type of care and no requirements has nothing to go on', async () => {
  const registry = buildAdviceRegistry();
  const { handlers } = registry.toolsFor({
    ...ADVICE_TICKET,
    text: 'Bonjour, auriez-vous un conseil pour moi ? Merci.'
  });
  const result = await handlers.get(TOOL_NAMES.RECOMMEND_PRODUCTS)({ product: null, requirements: [] });
  assert.equal(result.outcome, 'nothing_to_go_on');
});

test('a misnamed collection is reconciled rather than reported uncurated', async () => {
  // Measured: the model asked for « Diag - Peaux Sensibles », inventing the
  // prefix off the collections that carry it, when the shop's is « Soins Peaux
  // Sensibles ». Exact matching called that uncurated, and the reply told the
  // customer the shop had no sensitive-skin selection — which was false. The
  // candidate set is closed, so reconciling cannot reach anything unactivated.
  const sensibles = {
    handle: 'peaux-sensibles',
    title: 'Soins Peaux Sensibles',
    axis: 'concern',
    productIds: ['gid/2']
  };
  const registry = buildAdviceRegistry([SERUMS, sensibles]);
  const { handlers } = registry.toolsFor(ADVICE_TICKET);
  const result = await handlers.get(TOOL_NAMES.RECOMMEND_PRODUCTS)({
    product: null,
    requirements: ['Diag - Peaux Sensibles']
  });

  assert.deepEqual(result.data.unknown, [], 'it was still reported as uncurated');
  assert.ok(result.data.matchedOn.includes('peaux-sensibles'));
});

// --- was the promotion applied to this order ------------------------------------

const PROMOTED_TICKET = {
  category: 'order',
  request_kind: 'problem',
  level: 2,
  shopify_order_number: '#6827',
  resolvedContext: {
    order: {
      name: '#6827',
      promotions: {
        applied: [{ name: 'Sauna Visage offert', kind: 'automatic', percentage: 100, amount: null }],
        codes: [],
        total: 20.9,
        gifts: [
          {
            title: 'Sauna Visage/Bain Vapeur - 6 Galets Aromatiques',
            value: 20.9,
            promotions: ['Sauna Visage offert']
          }
        ],
        reductions: [],
        samples: [{ title: 'Caresse Regard Sublime - échantillon' }]
      }
    }
  }
};

test('an applied gift is reported by name, with the promotion that gave it', async () => {
  const registry = buildRegistry();
  const { handlers } = registry.toolsFor(PROMOTED_TICKET);
  const result = await handlers.get(TOOL_NAMES.CHECK_ORDER_PROMOTION)({});

  assert.equal(result.outcome, 'applied');
  assert.match(result.promptText, /Sauna Visage\/Bain Vapeur/);
  assert.match(result.promptText, /Sauna Visage offert/);
  assert.match(result.promptText, /20\.9/);
  assert.equal(result.data.gifts, 1);
  // The samples travel too, so a reply can say what they are instead of letting
  // the customer read them as the gift.
  assert.match(result.promptText, /échantillon/i);
  assert.equal(result.data.samples, 1);
});

test('nothing applied is an answer, and samples are not counted as a gift', async () => {
  const ticket = {
    ...PROMOTED_TICKET,
    shopify_order_number: '#6913',
    resolvedContext: {
      order: {
        name: '#6913',
        promotions: { applied: [], codes: [], total: 0, gifts: [], reductions: [], samples: [{ title: 'Mini soin' }] }
      }
    }
  };
  const { handlers } = buildRegistry().toolsFor(ticket);
  const result = await handlers.get(TOOL_NAMES.CHECK_ORDER_PROMOTION)({});

  assert.equal(result.outcome, 'none');
  assert.match(result.promptText, /Aucune promotion/);
  assert.equal(result.data.applied, false);
  assert.equal(result.data.samples, 1);
});

test('no confirmed order means no claim about what was applied', async () => {
  const { handlers } = buildRegistry().toolsFor({ category: 'order', request_kind: 'problem', level: 2 });
  const result = await handlers.get(TOOL_NAMES.CHECK_ORDER_PROMOTION)({});

  assert.equal(result.outcome, 'not_resolved');
  assert.deepEqual(result.caveats, ['order_unconfirmed']);
});

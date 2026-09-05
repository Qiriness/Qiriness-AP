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
  assert.deepEqual(result.caveats, ['basket_unseeable']);
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

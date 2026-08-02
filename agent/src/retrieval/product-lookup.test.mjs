import assert from 'node:assert/strict';
import test from 'node:test';

import { createProductLookup } from './product-lookup.mjs';

const CATALOGUE = [
  { id: '2', title: 'Coffret Temps Sublime – Rituel Anti-Âge Global Crème et Gommage', status: 'active' },
  { id: '4', title: 'Crème Nuit Anti-Âge Régénérante Rétinol Vitamine C - Caresse Temps Sublime', status: 'active' },
  { id: '11', title: 'Masque LED Visage Éclat & Régénération', status: 'active' },
  { id: '15', title: 'Caresse Temps Sublime Nuit - échantillon', status: 'unlisted' }
];

const ROWS = {
  '2': {
    id: '2', title: 'Coffret Temps Sublime – Rituel Anti-Âge Global Crème et Gommage',
    status: 'active', available_stock: 298, short_description: 'Le coffret rituel.',
    product_faqs: [], product_ingredients: [], variants: []
  },
  '4': {
    id: '4', title: 'Crème Nuit Anti-Âge Régénérante Rétinol Vitamine C - Caresse Temps Sublime',
    status: 'active', available_stock: 24, short_description: 'La crème de nuit.',
    product_faqs: [], product_ingredients: [], variants: []
  },
  '11': {
    id: '11', title: 'Masque LED Visage Éclat & Régénération', status: 'active',
    available_stock: 38, short_description: 'Masque LED.', usage_instructions: '10 minutes.',
    active_ingredients: 'LED rouge', product_faqs: [], product_ingredients: [], variants: []
  }
};

/**
 * Records every query so the tests can assert on what was asked for.
 *
 * Honours the `Range` header, because `supabaseSelectAll` pages by it and stops
 * only on an empty page — a mock that returns the same rows regardless of range
 * loops forever rather than failing.
 */
function buildSupabase() {
  const queries = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    queries.push(String(url));
    const parsed = new URL(String(url));

    const from = Number(String(init?.headers?.Range || '0-999').split('-')[0]);

    const id = parsed.searchParams.get('id');
    if (id) {
      const row = ROWS[id.replace('eq.', '')];
      return { ok: true, json: async () => (from > 0 || !row ? [] : [row]) };
    }

    // Title index: honour the status filter the way PostgREST would.
    const status = parsed.searchParams.get('status');
    const rows = status === 'eq.active' ? CATALOGUE.filter((p) => p.status === 'active') : CATALOGUE;
    return { ok: true, json: async () => (from > 0 ? [] : rows) };
  };
  return { queries, restore: () => { globalThis.fetch = originalFetch; } };
}

function tools() {
  return createProductLookup({
    supabase: { baseUrl: 'https://example.test/rest/v1', key: 'k' },
    shopId: 'shop-1'
  });
}

test('only active products are candidates', async () => {
  // The measured failure: an `unlisted` échantillon beat the real coffret at
  // 0.88, because a short title is mostly covered by any question naming it.
  const { queries, restore } = buildSupabase();
  try {
    await tools().lookupProduct('le masque LED');
    assert.match(queries[0], /status=eq\.active/);
  } finally {
    restore();
  }
});

test('the title index loads titles only, never descriptions', async () => {
  const { queries, restore } = buildSupabase();
  try {
    await tools().lookupProduct('le masque LED');
    assert.doesNotMatch(queries[0], /description|product_faqs|variants/);
  } finally {
    restore();
  }
});

test('an ambiguous name returns BOTH products, not a refusal', async () => {
  // Silently picking one is the dangerous case; withholding both is merely
  // unhelpful. "Le coffret Caresse Temps Sublime" genuinely names two products.
  const { restore } = buildSupabase();
  try {
    const r = await tools().lookupProduct('le coffret Caresse Temps sublime jour et nuit');
    assert.equal(r.found, true);
    assert.equal(r.ambiguous, true);
    assert.equal(r.products.length, 2);
    assert.equal(r.product, undefined, 'no single answer is offered on ambiguity');
  } finally {
    restore();
  }
});

test('the rendered text states the ambiguity before either product', async () => {
  // Without the preamble a model treats the first block as the answer and the
  // second as extra detail — the silent pick, one layer up.
  const { restore } = buildSupabase();
  try {
    const r = await tools().lookupProduct('le coffret Caresse Temps sublime jour et nuit');
    assert.match(r.promptText, /^Attention : la demande peut correspondre à 2 produits/);
    assert.ok(r.promptText.indexOf('Attention') < r.promptText.indexOf('# '), 'warning comes first');
    assert.equal((r.promptText.match(/^# /gm) || []).length, 2, 'both products rendered');
  } finally {
    restore();
  }
});

test('a resolved product returns structured context and rendered text', async () => {
  const { restore } = buildSupabase();
  try {
    const r = await tools().lookupProduct('votre masque visage LED');
    assert.equal(r.found, true);
    assert.equal(r.ambiguous, false);
    assert.equal(r.products.length, 1);
    assert.equal(r.product.title, 'Masque LED Visage Éclat & Régénération');
    assert.equal(r.product.usage.instructions, '10 minutes.');
    assert.match(r.promptText, /## Conseils d'utilisation/);
  } finally {
    restore();
  }
});

test('the stock tool returns availability and nothing else', async () => {
  // The reason it is a separate tool: a stock check must not cost the
  // ingredients, the FAQ and every variant in tokens.
  const { restore } = buildSupabase();
  try {
    const r = await tools().lookupStock('le masque LED est-il en stock ?');
    assert.equal(r.found, true);
    assert.equal(r.ambiguous, false);
    assert.equal(r.available, 38);
    assert.equal(r.inStock, true);
    assert.equal(r.purchasable, true);
    assert.equal(r.product, undefined, 'no product context');
    assert.equal(r.promptText, undefined);
  } finally {
    restore();
  }
});

test('a product nobody sells any more resolves to nothing', async () => {
  const { restore } = buildSupabase();
  try {
    const r = await tools().lookupProduct('Galets Bain lacté relaxant, je ne vois plus ce produit');
    assert.equal(r.found, false);
    assert.equal(r.reason, 'no_match');
  } finally {
    restore();
  }
});

test('the title index is built once and reused across calls', async () => {
  const { queries, restore } = buildSupabase();
  try {
    const lookup = tools();
    await lookup.lookupProduct('le masque LED');
    const afterFirst = queries.filter((q) => /select=id%2Ctitle%2Chandle%2Cstatus/.test(q)).length;
    await lookup.lookupStock('le masque LED');
    assert.equal(queries.filter((q) => /select=id%2Ctitle%2Chandle%2Cstatus/.test(q)).length, afterFirst);
  } finally {
    restore();
  }
});

test('refresh forces the index to be rebuilt after a product sync', async () => {
  const { queries, restore } = buildSupabase();
  try {
    const lookup = tools();
    await lookup.lookupProduct('le masque LED');
    const before = queries.length;
    lookup.refresh();
    await lookup.lookupProduct('le masque LED');
    assert.ok(queries.length > before);
  } finally {
    restore();
  }
});

test('an ambiguous stock question answers for every candidate', async () => {
  // Two integers cost nothing, and "one is out of stock, the other is not" is a
  // usable reply where "which do you mean?" is another round trip.
  const { restore } = buildSupabase();
  try {
    const r = await tools().lookupStock('le coffret Caresse Temps sublime');
    assert.equal(r.found, true);
    assert.equal(r.ambiguous, true);
    assert.equal(r.products.length, 2);
    for (const p of r.products) {
      assert.ok(typeof p.title === 'string');
      assert.ok('inStock' in p);
    }
    assert.equal(r.available, undefined, 'no flattened single answer on ambiguity');
  } finally {
    restore();
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { refsFromHistory, detectReference } from './conversation-refs.mjs';
import { buildCatalogue } from './product-repository.mjs';
import { buildResolutionIndex, commercialName, editDistance, resolveProducts } from './product-resolver.mjs';

// An invented brand, so nothing can pass by matching a Qiriness word. Its lines
// are « Brume Polaire » and « Rosée d'Aube »; its brand words « Nectar » (always
// a sérum) and « Voile » (always a crème).
const row = (id, title, sku, extra = {}) => ({ id, handle: id, title, product_type: 'Visage', variants: [{ price: '20', sku }], available_stock: 5, ...extra });
const ROWS = [
  row('p1', 'Sérum Hydratant Intense - Nectar Brume Polaire', 'N100'),
  row('p2', 'Crème Riche Nutrition - Voile Brume Polaire', 'V100'),
  row('p3', 'Crème Légère Matité - Voile Brume Polaire Light', 'V101'),
  row('p4', 'Masque Apaisant - Brume Polaire', 'M100'),
  row('p5', 'Coffret Rituel - Brume Polaire', 'C100'),
  row('p6', 'Sérum Éclat Vitamine C - Nectar Rosée d’Aube', 'N200'),
  row('p7', 'Crème Éclat Jour - Voile Rosée d’Aube', 'V200'),
  row('p8', 'Masque Peeling Doux - Grain de Lune', 'M200'),
  row('p9', 'Crème Mains Réparatrice - Voile Mains Satin', 'V300'),
  row('p10', 'Brume Polaire - échantillon', 'N100S', { product_type: 'SAMPLE PRODUCT' })
];
const CATALOGUE = buildCatalogue(ROWS, []);
const INDEX = buildResolutionIndex(CATALOGUE);
const resolve = (message, ctx = {}) => resolveProducts(message, { index: INDEX, ...ctx });
const ids = (r) => r.products.map((p) => p.id).sort();

test('the vocabulary is learned from the titles: care types, brand synonyms, identity words', () => {
  assert.deepEqual([...INDEX.careTypes.values()].sort(), ['Crème', 'Masque', 'Sérum']);
  assert.equal(INDEX.synonyms.get('nectar'), 'serum');
  assert.equal(INDEX.synonyms.get('voile'), 'creme');
  for (const word of ['brume', 'polaire', 'rosee', 'aube']) assert.ok(INDEX.identity.has(word), word);
  for (const word of ['hydratant', 'creme', 'serum']) assert.ok(!INDEX.identity.has(word), word);
  assert.equal(commercialName('Crème Anti-âge Globale - Acide Hyaluronique & Rétinol - Temps Sublime 50 ml'), 'Temps Sublime');
});

test('samples are never candidates', () => {
  assert.ok(!INDEX.byId.has('p10'));
});

test('the contract has every field, always', () => {
  const r = resolve('bonjour');
  assert.deepEqual(Object.keys(r).sort(), ['candidates', 'clarification', 'pending', 'products', 'range', 'status', 'unresolved_mentions']);
  assert.equal(r.status, 'unresolved');
});

test('an exclusive commercial name is exact; a SKU is exact', () => {
  const r = resolve('la Voile Brume Polaire Light');
  assert.equal(r.status, 'resolved');
  assert.deepEqual(ids(r), ['p3']);
  assert.equal(r.products[0].match_strength, 'exact');
  assert.equal(resolve('infos sur N200 svp').products[0].id, 'p6');
});

test('a brand synonym or a care type narrows a shared line', () => {
  assert.deepEqual(ids(resolve('le nectar Brume Polaire')), ['p1']);
  assert.deepEqual(ids(resolve('le sérum Brume Polaire')), ['p1'], 'sérum ≈ Nectar, learned');
  assert.deepEqual(ids(resolve('le masque Brume Polaire')), ['p4']);
});

test('several products in one message', () => {
  const r = resolve('compare le Nectar Rosée d’Aube et la Voile Mains Satin');
  assert.equal(r.status, 'resolved');
  assert.deepEqual(ids(r), ['p6', 'p9']);
});

test('a type borrowed across « et »: « le sérum et le masque Brume Polaire »', () => {
  assert.deepEqual(ids(resolve('le sérum et le masque Brume Polaire')), ['p1', 'p4']);
});

test('ambiguous is never a pick: three products, or the care types they span', () => {
  const few = resolve('la crème Brume Polaire');
  assert.equal(few.status, 'ambiguous');
  assert.equal(few.products.length, 0);
  assert.equal(few.clarification.kind, 'choose_product');
  assert.deepEqual(few.clarification.options.map((o) => o.id).sort(), ['p2', 'p3']);

  const many = resolve('le soin Brume Polaire');
  assert.equal(many.status, 'ambiguous');
  assert.equal(many.clarification.kind, 'choose_care_type');
  assert.deepEqual(many.clarification.options.map((o) => o.label).sort(), ['Crème', 'Masque', 'Sérum']);
  assert.ok(many.clarification.options.length <= 3);
});

test('a chip or a follow-up answers the clarification deterministically', () => {
  const asked = resolve('le soin Brume Polaire');
  const refs = { lastSet: [], lastRecommended: [], lastSingle: null, focus: null, pending: asked.pending };
  assert.deepEqual(ids(resolve('Sérum', { refs, choice: 'Sérum' })), ['p1']);
  assert.deepEqual(ids(resolve('p4', { refs, choice: 'p4' })), ['p4']);
  assert.deepEqual(ids(resolve('le masque', { refs })), ['p4']);
  assert.equal(resolve('la crème', { refs }).clarification.kind, 'choose_product');
});

test('typos are corrected towards catalogue words, and reported', () => {
  const r = resolve('le nectar rosé d’aubbe');
  assert.deepEqual(ids(r), ['p6']);
  assert.equal(r.products[0].match_strength, 'strong');
  assert.match(r.products[0].match_reason, /corrected spelling/);
  assert.equal(editDistance('sourse', 'source'), 1);
  assert.equal(editDistance('beuaty', 'beauty'), 1, 'a swap is one edit');
});

test('a name word used as plain French is not a mention', () => {
  assert.equal(resolve('la lune est belle ce soir').status, 'unresolved');
});

test('partial: what resolves, and what is named but unknown', () => {
  const r = resolve('la Voile Mains Satin et la crème licorne magique');
  assert.equal(r.status, 'partial');
  assert.deepEqual(ids(r), ['p9']);
  assert.deepEqual(r.unresolved_mentions, ['la creme licorne magique']);
});

test('discovery questions resolve nothing', () => {
  for (const q of ['quels sérums avez-vous ?', 'une crème pour peau sèche ?', 'que me conseillez-vous ?', 'avez-vous des masques ?']) {
    assert.equal(resolve(q).status, 'unresolved', q);
  }
});

test('a range cue returns the line, not a product', () => {
  const r = resolve('toute la gamme Brume Polaire');
  assert.ok(r.range);
  assert.deepEqual([...r.range.ids].sort(), ['p1', 'p2', 'p3', 'p4', 'p5']);
});

test('conversation references: les deux, l’autre, le premier, celui-ci', () => {
  const refs = { lastSet: ['p1', 'p4'], lastRecommended: ['p6', 'p7', 'p9'], lastSingle: null, focus: 'p1', pending: null };
  assert.deepEqual(ids(resolve('quelle différence entre les deux ?', { refs })), ['p1', 'p4']);
  assert.deepEqual(ids(resolve('et l’autre ?', { refs })), ['p4']);
  assert.deepEqual(ids(resolve('je prends le premier', { refs })), ['p1']);
  assert.deepEqual(ids(resolve('les trois que vous m’avez conseillés', { refs })), ['p6', 'p7', 'p9']);
  assert.equal(resolve('celui-ci ?', { refs }).status, 'ambiguous');
});

test('« est-elle … ? » is the product just discussed; a plain « il » is not', () => {
  // Dev store, 2026-10-16: the hand cream, then « est-elle recommandée pour les peaux sensibles ».
  const refs = { lastSet: ['p9'], lastRecommended: ['p9'], lastSingle: 'p9', focus: 'p9', pending: null };
  assert.deepEqual(ids(resolve('est-elle recommandée pour les peaux sensibles', { refs })), ['p9']);
  assert.deepEqual(ids(resolve('convient-il aux peaux sèches ?', { refs })), ['p9']);
  assert.deepEqual(ids(resolve('a-t-elle du parfum ?', { refs })), ['p9']);
  assert.equal(detectReference('il fait tres chaud chez moi', { refs }), null);
});

test('precedence: an explicit name beats the page; the page answers « ça »', () => {
  assert.deepEqual(ids(resolve('et la Voile Mains Satin ?', { pageProductId: 'p1' })), ['p9']);
  assert.deepEqual(ids(resolve('est-ce que ça convient aux peaux sèches ?', { pageProductId: 'p1' })), ['p1']);
  assert.equal(resolve('est-ce que ça convient aux peaux sèches ?', { pageProductId: 'p1' }).products[0].match_reason, 'current page');
});

test('the memory is folded from the message log', () => {
  const rows = [
    { role: 'user', context: { resolution: { ids: ['p1'] } } },
    { role: 'assistant', context: { refs: { recommended: ['p6', 'p7'], mentioned: ['p6', 'p7'] } } },
    { role: 'user', context: { resolution: { ids: [], pending: { mention: 'le soin x', ids: ['p2', 'p3'] } } } },
    { role: 'assistant', context: { refs: { recommended: [], mentioned: [] } } }
  ];
  const refs = refsFromHistory(rows);
  assert.deepEqual(refs.lastSet, ['p6', 'p7']);
  assert.deepEqual(refs.lastRecommended, ['p6', 'p7']);
  assert.deepEqual(refs.pending, { mention: 'le soin x', ids: ['p2', 'p3'], settled: [], labels: {} });
  assert.equal(detectReference('les deux', { refs }).ids.length, 2);
});

test('it is fast: a median message well under 5 ms, even on a loaded machine', () => {
  // A median, not a total: the full suite runs thousands of tests in parallel,
  // and a wall-clock total measures the neighbours as much as the resolver.
  const times = [];
  for (let i = 0; i < 200; i += 1) {
    const started = process.hrtime.bigint();
    resolve('compare le sérum et le masque Brume Polaire avec la Voile Mains Satin');
    times.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[100] < 5, `median ${times[100].toFixed(2)} ms`);
});

test('« les deux » with only one product in play: that one, and the shortfall reported', () => {
  const refs = { lastSet: ['p9'], lastRecommended: ['p9'], lastSingle: 'p9', focus: null, pending: null };
  const r = resolve('quelle est la différence entre les deux ?', { refs });
  assert.equal(r.status, 'partial');
  assert.deepEqual(ids(r), ['p9']);
  assert.deepEqual(r.unresolved_mentions, ['les deux']);
});

test('a curated range collection is the membership of « la gamme X »; titles are only the fallback', () => {
  // The team's « Brume Polaire » range leaves out the coffret (p5) and adds the
  // mask p8, whose title shares no word with the line.
  const curated = buildCatalogue(ROWS, [{ handle: 'gamme-brume-polaire', title: 'Brume Polaire', axis: 'range', product_ids: ['g1', 'g2', 'g4', 'g8'] }]);
  for (const p of curated.products) p.collections = { p1: ['gamme-brume-polaire'], p2: ['gamme-brume-polaire'], p4: ['gamme-brume-polaire'], p8: ['gamme-brume-polaire'] }[p.id] ?? [];
  const index = buildResolutionIndex(curated);
  const r = resolveProducts('toute la gamme Brume Polaire', { index });
  assert.equal(r.range.source, 'collection');
  assert.equal(r.range.name, 'Brume Polaire');
  assert.deepEqual([...r.range.ids].sort(), ['p1', 'p2', 'p4', 'p8']);
  // No curated range for Rosée d'Aube: the titles decide.
  assert.equal(resolveProducts('la gamme Rosée d’Aube', { index }).range.source, 'titles');
});

test('a range not in the title still names the product, from the product knowledge (owner, 2026-10-19)', () => {
  // « Contour des Yeux … - Voile Regard Polaire » is a Brume Polaire product its title does not say.
  const rows = [...ROWS, row('p11', 'Contour des Yeux Lissant - Voile Regard Polaire', 'V400')];
  const catalogue = buildCatalogue(rows, []);
  const withRanges = buildResolutionIndex(catalogue, { ranges: new Map([['p11', 'Brume Polaire'], ['p2', 'Brume Polaire'], ['p3', 'Brume Polaire']]) });
  const r = resolveProducts('le contour des yeux brume polaire et la crème rosée d’aube', { index: withRanges });
  assert.deepEqual(r.products.map((p) => p.id).sort(), ['p11', 'p7']);
  // Without the knowledge, the eye contour is not a candidate at all.
  const without = resolveProducts('le contour des yeux brume polaire', { index: buildResolutionIndex(catalogue) });
  assert.ok(!without.products.some((p) => p.id === 'p11'));
  assert.ok(!without.candidates.some((c) => c.options?.some((o) => o.id === 'p11')));
});

test('« …Brume Polaire riche et la Light »: the short second mention borrows the line just named', () => {
  assert.deepEqual(ids(resolve('comparer la crème Voile Brume Polaire riche et la Light')), ['p2', 'p3']);
  assert.deepEqual(ids(resolve('compare the Brume Polaire rich cream and the Light')), ['p2', 'p3']);
  // Alone, « la light » stays plain words.
  assert.deepEqual(ids(resolve('la light')), []);
});

test('the answer to « laquelle ? » keeps the product found beside it; labels tell the options apart (owner, 2026-10-19)', () => {
  const first = resolve('comparer la crème Brume Polaire et le sérum Rosée d’Aube');
  assert.equal(first.status, 'partial');
  assert.deepEqual(ids(first), ['p6']);
  const labels = first.clarification.options.map((o) => o.label);
  // No label another option also carries: « Crème Voile Brume Polaire » is the Light one's words too.
  for (const [i, label] of labels.entries()) assert.ok(!labels.some((other, j) => j !== i && other.includes(label)), label);
  const refs = refsFromHistory([{ role: 'assistant', context: { resolution: { ids: ['p6'], pending: first.pending } } }]);
  assert.deepEqual(refs.pending.settled, ['p6']);
  // A chip, or its label typed back: both products, the comparison can run.
  const p2 = first.clarification.options.find((o) => o.id === 'p2');
  assert.deepEqual(ids(resolve('x', { refs, choice: 'p2' })), ['p2', 'p6']);
  assert.deepEqual(ids(resolve(p2.label.toUpperCase(), { refs })), ['p2', 'p6']);
  // The model asking again in its own words, after the customer chose: settled, not asked again.
  const again = resolve('crème Brume Polaire, sérum Rosée d’Aube', { refs, known: ['p2', 'p6'] });
  assert.equal(again.status, 'resolved');
  assert.deepEqual(ids(again), ['p2', 'p6']);
});

test('« moins » and « plus » are words, not typos of « mains »: « Moins de 25 ans » names no product', () => {
  for (const message of ['Moins de 25 ans', 'Un soin moins cher', 'Less than 25']) {
    const r = resolve(message);
    assert.deepEqual(r.products, [], message);
    assert.ok(!r.clarification, message);
  }
  // The real word still resolves.
  assert.deepEqual(ids(resolve('la crème mains')), ['p9']);
});

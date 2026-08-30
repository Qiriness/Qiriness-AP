import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ENTITY_TYPES,
  MAX_OPENING_MOVES,
  MAX_TASKS,
  normaliseDecomposition,
  normaliseEntities,
  planBudget,
  planEvidence,
  planMoves,
  planTasks,
  planToolNames
} from './decompose-rules.mjs';
import { TOOL_NAMES, allowedTools, openingMoves } from './investigation-rules.mjs';

const TICKET = { category: 'product', request_kind: 'question', text: 'Le masque LED ?' };

// --- clamping to the taxonomy ------------------------------------------------

test('a well-formed decomposition is kept as written', () => {
  const { tasks } = normaliseDecomposition({
    tasks: [
      { question: 'Le masque LED convient-il aux peaux sensibles ?', category: 'product', request_kind: 'question' },
      { question: 'Où est la commande #4854 ?', category: 'delivery', request_kind: 'problem' }
    ]
  }, TICKET);

  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks.map((t) => t.category), ['product', 'delivery']);
  assert.deepEqual(tasks.map((t) => t.request_kind), ['question', 'problem']);
});

test('an invented subject is clamped to the ticket, never passed through', () => {
  // The tool table has no row for a subject the model made up, so an unclamped
  // value would route to an empty registry and silently do nothing.
  const { tasks } = normaliseDecomposition({
    tasks: [{ question: 'x', category: 'shipping_problems', request_kind: 'urgent' }]
  }, TICKET);

  assert.equal(tasks[0].category, 'product', "falls back to the ticket's own subject");
  assert.equal(tasks[0].request_kind, 'question');
});

test('every clamped value is one the tool table can actually route', () => {
  const { tasks } = normaliseDecomposition({
    tasks: [{ question: 'a', category: 'faq' }, { question: 'b', category: 'brand_story' }]
  }, TICKET);
  // faq and brand_story are knowledge-only: they are never ticket subjects.
  for (const t of tasks) {
    assert.ok(!['faq', 'brand_story'].includes(t.category), t.category);
  }
});

// --- degrading safely --------------------------------------------------------

test('an unusable answer degrades to exactly the pre-decomposition behaviour', () => {
  // One task, the ticket's own labels — which is what the pipeline did before
  // this existed. A bad decomposition can slow a ticket down, never strand it.
  for (const raw of [null, undefined, {}, { tasks: [] }, { tasks: 'nonsense' }]) {
    const { tasks } = normaliseDecomposition(raw, TICKET);
    assert.equal(tasks.length, 1, JSON.stringify(raw));
    assert.equal(tasks[0].category, 'product');
    assert.equal(tasks[0].question, 'Le masque LED ?');
  }
});

test('a ticket with no usable labels still produces a routable task', () => {
  const { tasks } = normaliseDecomposition({}, { text: 'quelque chose' });
  assert.equal(tasks[0].category, 'other');
  assert.equal(tasks[0].request_kind, 'question');
});

test('empty questions are dropped rather than routed', () => {
  const { tasks } = normaliseDecomposition({
    tasks: [{ question: '   ' }, { question: 'Une vraie question ?' }]
  }, TICKET);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].question, 'Une vraie question ?');
});

test('the same question twice is one task', () => {
  const { tasks } = normaliseDecomposition({
    tasks: [{ question: 'Où est ma commande ?' }, { question: 'où est ma commande ?' }]
  }, TICKET);
  assert.equal(tasks.length, 1);
});

test('task count is capped, because past a point it is rambling not decomposition', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ question: `question ${i}` }));
  assert.equal(normaliseDecomposition({ tasks: many }, TICKET).tasks.length, MAX_TASKS);
});

// --- entities ----------------------------------------------------------------

test('entities are deduped, trimmed and bucketed', () => {
  const e = normaliseEntities({
    order_numbers: ['4854', '4854', '  6216 '],
    products: ['masque LED'],
    codes: []
  });
  assert.deepEqual(e.order_numbers, ['4854', '6216']);
  assert.deepEqual(e.products, ['masque LED']);
  assert.deepEqual(e.codes, []);
});

test('unknown entity buckets are dropped, known ones always present', () => {
  const e = normaliseEntities({ shoe_sizes: ['42'], order_numbers: ['1'] });
  assert.deepEqual(Object.keys(e).sort(), [...ENTITY_TYPES].sort());
  assert.equal(e.shoe_sizes, undefined);
});

test('an absurdly long "entity" is rejected', () => {
  // A model that pastes half the email into an entity field must not have it
  // handed to a lookup as though it were an order number.
  const e = normaliseEntities({ order_numbers: ['x'.repeat(500)] });
  assert.deepEqual(e.order_numbers, []);
});

// The gate that used to sit here is gone. It skipped the model call on short
// tickets, which was right while this only split emails — but the same call now
// declares the ticket's evidence needs, and those must exist for every
// investigated ticket or the completeness report has a hole exactly where the
// short, ordinary tickets are. See the note in decompose-rules.mjs.

// --- planning: what the run actually gets ------------------------------------

const SPLIT = [
  { question: 'Le masque LED convient-il aux peaux sensibles ?', category: 'product', request_kind: 'question' },
  { question: 'Mon code BIENVENUE10 est refusé', category: 'promotions', request_kind: 'problem' }
];

test('decomposition is not a second categoriser: one task keeps the ticket labels', () => {
  // The categoriser ran on the same text, and its value is the one stored and
  // reviewed. Splitting may add a request, never re-route the classified one.
  const { tasks } = planTasks(TICKET, [{ question: 'q', category: 'account', request_kind: 'problem' }]);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].category, 'product');
  assert.equal(tasks[0].request_kind, 'question');
  assert.equal(tasks[0].question, 'q', 'the sharpened wording is still kept');
});

test('a task in a disabled subject is dropped, not quietly enabled', () => {
  // `legal_privacy` carries an EMPTY tool set on purpose — an RGPD request is
  // answered by a person, and an agent reading customer records to prepare one
  // is exactly the access this codebase minimises. (`cosmetovigilance` stood
  // here until 2026-08-30, when it gained one lookup.) A reported adverse
  // reaction goes to a person untouched. A model naming it must not route it.
  const { tasks, skipped } = planTasks(TICKET, [
    SPLIT[0],
    { question: 'suppression de mes données personnelles', category: 'legal_privacy', request_kind: 'problem' }
  ]);
  assert.deepEqual(tasks.map((t) => t.category), ['product']);
  assert.deepEqual(skipped.map((t) => t.category), ['legal_privacy']);
});

test('skipped tasks are reported rather than discarded', () => {
  // Half an email silently ignored is worse than an email never split.
  const { tasks, skipped } = planTasks(TICKET, [
    { question: 'a', category: 'legal_privacy', request_kind: 'problem' },
    { question: 'b', category: 'legal_privacy', request_kind: 'question' }
  ]);
  assert.equal(skipped.length, 2);
  assert.equal(tasks.length, 1, 'falls back to the ticket itself');
  assert.equal(tasks[0].category, 'product');
});

test('level 4 leaves no task routable, whatever the split says', () => {
  const { tasks } = planTasks({ ...TICKET, level: 4 }, SPLIT);
  assert.equal(tasks.length, 1);
  assert.deepEqual(planToolNames({ ...TICKET, level: 4 }, tasks), []);
});

// --- planning: tools ---------------------------------------------------------

test('tools are the union of what each task is allowed', () => {
  const names = planToolNames(TICKET, SPLIT);
  assert.ok(names.includes(TOOL_NAMES.LOOKUP_PRODUCT), 'from the product task');
  assert.ok(names.includes(TOOL_NAMES.LOOKUP_PROMOTION), 'from the promotions task');
});

test('the union never exceeds the sum of the parts', () => {
  const union = new Set(planToolNames(TICKET, SPLIT));
  const allowed = new Set([
    ...allowedTools('product', 'question', 1),
    ...allowedTools('promotions', 'problem', 1)
  ]);
  for (const name of union) assert.ok(allowed.has(name), name);
});

test('one task binds exactly the tools the ticket had before decomposition', () => {
  // The no-regression property: an ordinary ticket is investigated identically.
  assert.deepEqual(
    planToolNames(TICKET, planTasks(TICKET, []).tasks).sort(),
    allowedTools('product', 'question', 1).sort()
  );
});

test('the evidence checklist is unioned and deduplicated by key', () => {
  const keys = planEvidence([
    { category: 'product' },
    { category: 'product_stock' }
  ]).map((i) => i.key);
  assert.equal(new Set(keys).size, keys.length, 'product_identified appears in both');
  assert.ok(keys.includes('stock_known'));
});

// --- planning: opening moves -------------------------------------------------

test('one task produces exactly the opening moves it always did', () => {
  const moves = planMoves(TICKET, planTasks(TICKET, []).tasks, {});
  assert.deepEqual(moves, openingMoves(TICKET));
});

test('a split runs the opening moves of BOTH subjects', () => {
  const moves = planMoves(TICKET, SPLIT, {});
  const tools = moves.map((m) => m.tool);
  assert.ok(tools.includes(TOOL_NAMES.LOOKUP_PRODUCT));
  assert.ok(tools.includes(TOOL_NAMES.EXTRACT_PROMOTION_CODES));
});

test('the code extractor always gets the RAW email, never a paraphrase', () => {
  // A paraphrase is exactly where a literal code stops being present, and the
  // extractor matches against the real store list.
  const ticket = { ...TICKET, text: 'Bonjour, le code BIENVENUE10 ne marche pas.' };
  const move = planMoves(ticket, SPLIT, {}).find((m) => m.tool === TOOL_NAMES.EXTRACT_PROMOTION_CODES);
  assert.match(move.args.text, /BIENVENUE10/);
});

test('the semantic matchers get the sub-question, not the whole email', () => {
  const ticket = { ...TICKET, text: 'Le masque LED convient-il ? Et mon code est refusé.' };
  const move = planMoves(ticket, SPLIT, {}).find((m) => m.tool === TOOL_NAMES.LOOKUP_PRODUCT);
  assert.match(move.args.question, /peaux sensibles/);
  assert.doesNotMatch(move.args.question, /refusé/, 'the promotion half would compete for the match');
});

test('verbatim product names are prepended, because the matcher is IDF-weighted', () => {
  // « le masque » in a paraphrase carries none of the weight the real title does.
  const move = planMoves(TICKET, SPLIT, { products: ['Masque LED Hanbang'] })
    .find((m) => m.tool === TOOL_NAMES.LOOKUP_PRODUCT);
  assert.match(move.args.question, /^Masque LED Hanbang /);
});

test('opening moves are capped so a split cannot eat the whole budget', () => {
  const three = [SPLIT[0], SPLIT[1], { question: 'c', category: 'account', request_kind: 'question' }];
  assert.ok(planMoves(TICKET, three, {}).length <= MAX_OPENING_MOVES);
});

test('two tasks on the same subject do not run the same move twice', () => {
  const moves = planMoves(TICKET, [
    { question: 'même chose', category: 'product', request_kind: 'question' },
    { question: 'même chose', category: 'product', request_kind: 'question' }
  ], {});
  assert.equal(new Set(moves.map((m) => `${m.tool}:${JSON.stringify(m.args)}`)).size, moves.length);
});

test('a move never names a tool the plan did not allow', () => {
  const names = new Set(planToolNames(TICKET, SPLIT));
  for (const move of planMoves(TICKET, SPLIT, {})) {
    assert.ok(names.has(move.tool), move.tool);
  }
});

// --- planning: budget --------------------------------------------------------

test('one task keeps the budget exactly as it was', () => {
  assert.equal(planBudget(6, 1), 6);
});

test('the budget grows with the split, because tool calls are the cheap bound', () => {
  // The expensive bound is how many times the model speaks, and that does not move.
  assert.ok(planBudget(6, 2) > planBudget(6, 1));
  assert.ok(planBudget(6, 3) > planBudget(6, 2));
});

test('the budget cannot be inflated past the task cap', () => {
  assert.equal(planBudget(6, 99), planBudget(6, MAX_TASKS));
});

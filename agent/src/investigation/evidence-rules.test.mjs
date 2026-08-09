import assert from 'node:assert/strict';
import test from 'node:test';

import { MISSING_FIELDS } from './case-file.mjs';
import {
  NEED_KEYS,
  NEED_STATES,
  normaliseNeeds,
  resolveNeeds,
  summariseNeeds
} from './evidence-rules.mjs';
import { TOOL_NAMES } from './investigation-rules.mjs';

const ALL_TOOLS = Object.values(TOOL_NAMES);
const entry = (id, tool, outcome) => ({ id, tool, outcome });

// --- the vocabulary ----------------------------------------------------------

test('every need names a MISSING_FIELDS key or none at all', () => {
  // The wording of a question to a customer is owned by case-file.mjs. A need
  // inventing its own key would produce a gap nothing knows how to ask about.
  for (const item of resolveNeeds(NEED_KEYS, [], ALL_TOOLS)) {
    if (item.asksCustomer !== null) {
      assert.ok(MISSING_FIELDS[item.asksCustomer], `${item.need} → ${item.asksCustomer}`);
    }
  }
});

test('every need is either reachable by a real tool or explicitly unwired', () => {
  const unwired = resolveNeeds(NEED_KEYS, [], ALL_TOOLS)
    .filter((item) => item.state === 'unavailable')
    .map((item) => item.need);
  // Exactly two, and both deliberate: the abandoned-checkout tool is not in the
  // registry, and other_fact can never be closed by code.
  assert.deepEqual(unwired.sort(), ['checkout_state', 'other_fact']);
});

test('unknown needs are dropped rather than carried', () => {
  assert.deepEqual(normaliseNeeds(['product_identity', 'vibes', '', null]), ['product_identity']);
  assert.deepEqual(normaliseNeeds('nonsense'), []);
  assert.deepEqual(normaliseNeeds(), []);
});

test('a need declared twice is counted once', () => {
  assert.deepEqual(normaliseNeeds(['policy_answer', 'policy_answer']), ['policy_answer']);
});

// --- the four states ---------------------------------------------------------

test('a tool that found it satisfies the need, and the id is kept', () => {
  const [item] = resolveNeeds(['product_identity'], [entry('t1', TOOL_NAMES.LOOKUP_PRODUCT, 'found')], ALL_TOOLS);
  assert.equal(item.state, 'satisfied');
  assert.deepEqual(item.evidenceIds, ['t1']);
});

test('a tool that ran and came back empty leaves the need attempted, not satisfied', () => {
  // "We looked and there is nothing" is a real, reportable answer — and it is
  // NOT the same as having the fact.
  const [item] = resolveNeeds(['product_identity'], [entry('t1', TOOL_NAMES.LOOKUP_PRODUCT, 'no_match')], ALL_TOOLS);
  assert.equal(item.state, 'attempted');
  assert.deepEqual(item.evidenceIds, []);
});

test('an ambiguous product does not identify a product', () => {
  // A tie between two products is exactly when the reply must ask, not pick.
  const [item] = resolveNeeds(['product_identity'], [entry('t1', TOOL_NAMES.LOOKUP_PRODUCT, 'ambiguous')], ALL_TOOLS);
  assert.equal(item.state, 'attempted');
});

test('a tool that errored counts as attempted, never as satisfied', () => {
  const [item] = resolveNeeds(['customer_identity'], [entry('t1', TOOL_NAMES.LOOKUP_CUSTOMER, 'error')], ALL_TOOLS);
  assert.equal(item.state, 'attempted');
});

test('THE NEW SIGNAL: a tool was available, had budget, and was never called', () => {
  // This is the state that does not exist today, and the reason for the module.
  // Everything else is the world being uncooperative; this one is the agent.
  const [item] = resolveNeeds(['product_availability'], [entry('t1', TOOL_NAMES.LOOKUP_PRODUCT, 'found')], ALL_TOOLS);
  assert.equal(item.state, 'not_attempted');
});

test('a need no allowed tool could settle is unavailable, not a failure of the run', () => {
  // An `account` ticket has no product tools. Not looking is correct there.
  const [item] = resolveNeeds(['product_availability'], [], [TOOL_NAMES.LOOKUP_CUSTOMER]);
  assert.equal(item.state, 'unavailable');
});

test('checkout_state can never be satisfied, because nothing is wired for it', () => {
  // Deliberate: the abandoned-checkout module exists and is not in the registry.
  // Counting how often it is needed is the argument for wiring it.
  const [item] = resolveNeeds(['checkout_state'], [entry('t1', TOOL_NAMES.LOOKUP_PROMOTION, 'eligible')], ALL_TOOLS);
  assert.equal(item.state, 'unavailable');
});

// --- the distinctions that carry meaning -------------------------------------

test('an undetermined promotion settles validity but NOT eligibility', () => {
  // `undetermined` means the tool could not decide, usually because the basket
  // is invisible. Recording it as eligibility would launder the one gap the
  // promotion tool exists to be honest about.
  const ledger = [entry('t1', TOOL_NAMES.LOOKUP_PROMOTION, 'undetermined')];
  const resolved = resolveNeeds(['promotion_validity', 'promotion_eligibility'], ledger, ALL_TOOLS);
  assert.equal(resolved.find((i) => i.need === 'promotion_validity').state, 'satisfied');
  assert.equal(resolved.find((i) => i.need === 'promotion_eligibility').state, 'attempted');
});

test('a blocked code is a settled eligibility, not a failure to establish one', () => {
  const [item] = resolveNeeds(['promotion_eligibility'], [entry('t1', TOOL_NAMES.LOOKUP_PROMOTION, 'blocked')], ALL_TOOLS);
  assert.equal(item.state, 'satisfied');
});

test('a weak knowledge match does not answer a policy question', () => {
  // The same bar the case file uses: below `answerable`, chunks never reach it.
  const [item] = resolveNeeds(['policy_answer'], [entry('t1', TOOL_NAMES.SEARCH_KNOWLEDGE, 'weak')], ALL_TOOLS);
  assert.equal(item.state, 'attempted');
});

test('a need with two possible sources is satisfied by either', () => {
  const viaKnowledge = resolveNeeds(
    ['product_property'],
    [entry('t1', TOOL_NAMES.SEARCH_KNOWLEDGE, 'answerable')],
    ALL_TOOLS
  );
  const viaCatalogue = resolveNeeds(
    ['product_property'],
    [entry('t1', TOOL_NAMES.LOOKUP_PRODUCT, 'found')],
    ALL_TOOLS
  );
  assert.equal(viaKnowledge[0].state, 'satisfied');
  assert.equal(viaCatalogue[0].state, 'satisfied');
});

// --- the escape hatch --------------------------------------------------------

test('other_fact can never be closed by any tool output', () => {
  // A closed vocabulary's real danger is a FALSE GREEN: a ticket whose actual
  // requirement is unnameable declares two easy needs and reads as complete.
  const ledger = ALL_TOOLS.map((tool, i) => entry(`t${i + 1}`, tool, 'found'));
  const [item] = resolveNeeds(['other_fact'], ledger, ALL_TOOLS);
  assert.notEqual(item.state, 'satisfied');
});

test('other_fact keeps a ticket from ever reporting complete', () => {
  const ledger = [entry('t1', TOOL_NAMES.LOOKUP_PRODUCT, 'found')];
  const summary = summariseNeeds(resolveNeeds(['product_identity', 'other_fact'], ledger, ALL_TOOLS));
  assert.equal(summary.complete, false);
});

// --- the summary -------------------------------------------------------------

test('complete means every declared need was satisfied', () => {
  const ledger = [
    entry('t1', TOOL_NAMES.LOOKUP_PRODUCT, 'found'),
    entry('t2', TOOL_NAMES.SEARCH_KNOWLEDGE, 'answerable')
  ];
  const summary = summariseNeeds(resolveNeeds(['product_identity', 'policy_answer'], ledger, ALL_TOOLS));
  assert.equal(summary.complete, true);
  assert.equal(summary.satisfied, 2);
  assert.equal(summary.declared, 2);
});

test('declaring nothing is not completeness', () => {
  // A ticket with no declared needs has not been shown to be fully evidenced —
  // it has been shown that nobody said what it required.
  assert.equal(summariseNeeds([]).complete, false);
});

test('the summary counts every state and invents none', () => {
  const summary = summariseNeeds(resolveNeeds(NEED_KEYS, [], ALL_TOOLS));
  for (const state of NEED_STATES) {
    assert.equal(typeof summary[state], 'number', state);
  }
  assert.equal(
    NEED_STATES.reduce((total, state) => total + summary[state], 0),
    summary.declared
  );
});

test('resolution never throws on missing input', () => {
  assert.deepEqual(resolveNeeds(), []);
  assert.deepEqual(resolveNeeds(['product_identity'], null, null)[0].state, 'unavailable');
});

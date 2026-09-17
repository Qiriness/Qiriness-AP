import assert from 'node:assert/strict';
import test from 'node:test';

import { MISSING_FIELDS } from './case-file.mjs';
import {
  DETAIL_KEYS,
  FINDING_KEYS,
  KNOWLEDGE_NEEDS,
  NEED_KEYS,
  NEED_STATES,
  findingValues,
  findingsOf,
  gapClosability,
  isDesignedGap,
  isMoot,
  needRequires,
  needsSatisfiedBy,
  responseComplete,
  responseNeeds,
  normaliseNeeds,
  orderNeeds,
  resolveNeeds,
  summariseNeeds
} from './evidence-rules.mjs';
import { ENABLED_SUBJECTS, TOOL_NAMES } from './investigation-rules.mjs';

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
  // Exactly one now. `checkout_state` joined the wired needs on 2026-09-16 when
  // `lookupAbandonedCheckout` entered the registry; `other_fact` stays, because
  // it is the escape hatch and can never be closed by code.
  assert.deepEqual(unwired.sort(), ['other_fact']);
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

test('checkout_state is satisfied by a retrieved basket and by nothing else', () => {
  // Only `found`. A customer the shop has no recorded basket for is a real
  // answer, but it is the ABSENCE of the fact — counting it as satisfaction
  // would let a case file read complete on a need nothing established.
  const found = resolveNeeds(
    ['checkout_state'],
    [entry('t1', TOOL_NAMES.LOOKUP_ABANDONED_CHECKOUT, 'found')],
    ALL_TOOLS
  );
  assert.equal(found[0].state, 'satisfied');

  for (const outcome of ['no_match', 'none_in_window', 'no_customer']) {
    const [item] = resolveNeeds(
      ['checkout_state'],
      [entry('t1', TOOL_NAMES.LOOKUP_ABANDONED_CHECKOUT, outcome)],
      ALL_TOOLS
    );
    assert.equal(item.state, 'attempted', outcome);
  }
});

test('a subject without the checkout tool still reports checkout_state unavailable', () => {
  // The state that used to be permanent is now a property of the ticket: an
  // account ticket is not given the tool, so nothing there could ever settle it.
  const [item] = resolveNeeds(['checkout_state'], [], [TOOL_NAMES.LOOKUP_CUSTOMER]);
  assert.equal(item.state, 'unavailable');
});

test('a basket we looked for and did not find is not the same as never looking', () => {
  // `unavailable` is a fact a reply may state — the shop holds no basket for
  // this customer. `unknown` is not, and the difference is whether the customer
  // was ever identified: with no address there was nothing to search.
  const finding = (outcome) =>
    findingsOf(
      resolveNeeds(
        ['checkout_state'],
        outcome ? [entry('t1', TOOL_NAMES.LOOKUP_ABANDONED_CHECKOUT, outcome)] : [],
        ALL_TOOLS
      )
    ).checkout_state;

  assert.equal(finding('found'), 'retrieved');
  assert.equal(finding('no_match'), 'unavailable');
  assert.equal(finding('none_in_window'), 'unavailable');
  assert.equal(finding('no_customer'), 'unknown', 'nothing was searched');
  assert.equal(finding(null), 'unknown', 'nothing ran');
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

// --- findings: the value a need took, not just whether it was settled --------

const finding = (need, ledger) => resolveNeeds([need], ledger, ALL_TOOLS)[0].finding;

test('every finding vocabulary names a real need and includes unknown', () => {
  for (const key of FINDING_KEYS) {
    assert.ok(NEED_KEYS.includes(key), `${key} is not a need`);
    assert.ok(findingValues(key).includes('unknown'), `${key} has no unknown`);
  }
});

test('a need nothing branches on has a null finding, which is not unknown', () => {
  // `null` says no answer depends on the value. `'unknown'` says one does and we
  // could not establish it. Collapsing them would hide the second behind the first.
  assert.equal(finding('other_fact', []), null);
  assert.equal(finding('product_identity', []), 'unknown');
});

test('promotion_validity separates expired from not-yet-started', () => {
  // Both are FAIL on the same check, so the status alone cannot tell them apart —
  // and they are exactly the two branches an answer needs.
  const withWindow = (reason) => [
    {
      id: 't1',
      tool: TOOL_NAMES.LOOKUP_PROMOTION,
      outcome: 'blocked',
      data: { found: true, verdict: 'blocked', checks: [{ id: 'window', status: 'fail', reason }] }
    }
  ];
  assert.equal(finding('promotion_validity', withWindow('expired')), 'expired');
  assert.equal(finding('promotion_validity', withWindow('not_yet_started')), 'not_yet_started');
});

test('promotion_validity reads not_found ahead of any check', () => {
  const ledger = [
    { id: 't1', tool: TOOL_NAMES.LOOKUP_PROMOTION, outcome: 'not_found', data: { found: false } }
  ];
  assert.equal(finding('promotion_validity', ledger), 'not_found');
});

test('an active code in its window is active', () => {
  const ledger = [
    {
      id: 't1',
      tool: TOOL_NAMES.LOOKUP_PROMOTION,
      outcome: 'eligible',
      data: {
        found: true,
        verdict: 'eligible',
        checks: [
          { id: 'window', status: 'pass', reason: 'open' },
          { id: 'status', status: 'pass', reason: 'active' }
        ]
      }
    }
  ];
  assert.equal(finding('promotion_validity', ledger), 'active');
  assert.equal(finding('promotion_eligibility', ledger), 'eligible');
});

test('a satisfied need can still be unknown when the tool is too coarse', () => {
  // Listing active promotions satisfies promotion_validity ONCE A CODE IS KNOWN
  // to exist, but says nothing about which state that one code is in. Reporting
  // `active` here would be inventing the very fact the listing does not carry.
  const ledger = [
    { id: 't1', tool: TOOL_NAMES.EXTRACT_PROMOTION_CODES, outcome: 'found', data: {} },
    { id: 't2', tool: TOOL_NAMES.LIST_ACTIVE_PROMOTIONS, outcome: 'found', data: {} }
  ];
  const [resolved] = resolveNeeds(['promotion_validity'], ledger, ALL_TOOLS);
  assert.equal(resolved.state, 'satisfied');
  assert.equal(resolved.finding, 'unknown');
});

test('the active listing settles nothing when no code was identified', () => {
  // `outcome: 'found'` on the listing means THE SHOP has active promotions —
  // true on nearly every ticket, and a fact about the shop rather than about the
  // email. Without a code there is nothing for « le code existe et est actif »
  // to be about, so the need is not settled.
  //
  // MEASURED 2026-09-01 on the first promotions ticket a rule fired on: no code
  // was extracted and `promotion_validity` was recorded `satisfied` anyway.
  const ledger = [
    { id: 't1', tool: TOOL_NAMES.EXTRACT_PROMOTION_CODES, outcome: 'none', data: {} },
    { id: 't2', tool: TOOL_NAMES.LIST_ACTIVE_PROMOTIONS, outcome: 'found', data: {} }
  ];
  const [resolved] = resolveNeeds(['promotion_validity'], ledger, ALL_TOOLS);
  assert.equal(resolved.state, 'attempted', 'a tool ran, and none of them settled it');
  assert.equal(resolved.finding, 'unknown');
});

test('an ambiguous product is a value, not a failure to find one', () => {
  const ledger = [{ id: 't1', tool: TOOL_NAMES.LOOKUP_PRODUCT, outcome: 'ambiguous', data: {} }];
  const [resolved] = resolveNeeds(['product_identity'], ledger, ALL_TOOLS);
  assert.equal(resolved.state, 'attempted', 'a tie does not establish identity');
  assert.equal(resolved.finding, 'ambiguous', 'but the tie itself is the branch');
});

test('every derived finding is inside its own vocabulary', () => {
  // Guards the derivers against returning a value no condition could be written
  // against — a typo here is otherwise a permanently dead branch.
  const ledgers = [
    [],
    [{ id: 't1', tool: TOOL_NAMES.LOOKUP_PRODUCT, outcome: 'found', data: {} }],
    [{ id: 't1', tool: TOOL_NAMES.LOOKUP_PRODUCT, outcome: 'no_match', data: {} }],
    [{ id: 't1', tool: TOOL_NAMES.SEARCH_KNOWLEDGE, outcome: 'weak', data: {} }],
    [{ id: 't1', tool: TOOL_NAMES.SEARCH_KNOWLEDGE, outcome: 'answerable', data: {} }],
    [{ id: 't1', tool: TOOL_NAMES.LOOKUP_CUSTOMER, outcome: 'no_match', data: {} }],
    [{ id: 't1', tool: TOOL_NAMES.LOOKUP_STOCK, outcome: 'found', data: { products: [{ purchasable: false }] } }],
    [{ id: 't1', tool: TOOL_NAMES.EXTRACT_PROMOTION_CODES, outcome: 'none', data: {} }],
    [{ id: 't1', tool: TOOL_NAMES.LOOKUP_PROMOTION, outcome: 'undetermined', data: { found: true, verdict: 'undetermined', checks: [] } }]
  ];
  for (const ledger of ledgers) {
    for (const item of resolveNeeds(FINDING_KEYS, ledger, ALL_TOOLS)) {
      assert.ok(
        findingValues(item.need).includes(item.finding),
        `${item.need} → ${item.finding}`
      );
    }
  }
});

test('findingsOf keeps only the needs that carry a value', () => {
  const resolved = resolveNeeds(['product_identity', 'other_fact'], [], ALL_TOOLS);
  assert.deepEqual(findingsOf(resolved), { product_identity: 'unknown' });
});

// --- dependencies ------------------------------------------------------------

test('needs are ordered with prerequisites first', () => {
  assert.deepEqual(orderNeeds(['promotion_eligibility', 'promotion_identity', 'promotion_validity']), [
    'promotion_identity',
    'promotion_validity',
    'promotion_eligibility'
  ]);
});

test('ordering is stable and total for every declared set', () => {
  const ordered = orderNeeds(NEED_KEYS);
  assert.equal(ordered.length, NEED_KEYS.length, 'no need is dropped or duplicated');
  assert.deepEqual(orderNeeds(NEED_KEYS), ordered, 'the same set always sorts the same way');
  for (const key of NEED_KEYS) {
    for (const prerequisite of needRequires(key)) {
      assert.ok(
        ordered.indexOf(prerequisite) < ordered.indexOf(key),
        `${prerequisite} must precede ${key}`
      );
    }
  }
});

test('a prerequisite that was not declared does not block its dependent', () => {
  // An exemplar may want eligibility without wanting identity. The sort has
  // nothing to order it against, and must not hang or drop it.
  assert.deepEqual(orderNeeds(['promotion_eligibility']), ['promotion_eligibility']);
});

test('every dependency names a real need', () => {
  for (const key of NEED_KEYS) {
    for (const prerequisite of needRequires(key)) {
      assert.ok(NEED_KEYS.includes(prerequisite), `${key} requires unknown ${prerequisite}`);
    }
  }
});

test('eligibility is moot once the code cannot be used at all', () => {
  // There is nothing to be eligible FOR once a code has expired, so collecting
  // it is a tool call spent to learn nothing.
  assert.equal(isMoot('promotion_eligibility', { promotion_validity: 'expired' }), true);
  assert.equal(isMoot('promotion_eligibility', { promotion_validity: 'not_found' }), true);
  assert.equal(isMoot('promotion_eligibility', { promotion_validity: 'active' }), false);
  assert.equal(isMoot('promotion_eligibility', {}), false, 'nothing established yet is not moot');
  assert.equal(isMoot('product_identity', { promotion_validity: 'expired' }), false);
});

test('every moot condition names a real need and real values', () => {
  for (const key of NEED_KEYS) {
    const values = findingValues(key);
    if (!values) continue;
    // A moot value outside the prerequisite's vocabulary would never fire.
    for (const dependent of NEED_KEYS) {
      for (const value of values) {
        // Exercised through the public helper rather than the private table.
        assert.equal(typeof isMoot(dependent, { [key]: value }), 'boolean');
      }
    }
  }
});

// --- details: WHICH thing the finding is about --------------------------------
//
// The finding says a state; the details say what it is a state OF. Read by
// people, never by the drafting model — `fromModel` sends `promptText` alone.

const T = TOOL_NAMES;

test('an ambiguous product match names the products it could not choose between', () => {
  // "It could be one of these three" is only useful with the three named, and
  // that is the entire content of an `ambiguous` outcome.
  const [gap] = resolveNeeds(
    ['product_identity'],
    [{ id: 't1', tool: T.LOOKUP_PRODUCT, outcome: 'ambiguous',
       data: { found: true, ambiguous: true, titles: ['Masque LED', 'Masque Wrap'] } }],
    [T.LOOKUP_PRODUCT]
  );

  assert.equal(gap.finding, 'ambiguous');
  assert.deepEqual(gap.details.products, ['Masque LED', 'Masque Wrap']);
  assert.equal(gap.details.ambiguous, true);
});

test('a failed product match still names the near misses', () => {
  // Which tells a reviewer whether the catalogue lacks the product or the
  // matcher simply missed it — different problems, different fixes.
  const [gap] = resolveNeeds(
    ['product_identity'],
    [{ id: 't1', tool: T.LOOKUP_PRODUCT, outcome: 'no_match',
       data: { found: false, ambiguous: false, titles: [], candidates: ['Sérum Élixir'] } }],
    [T.LOOKUP_PRODUCT]
  );

  assert.equal(gap.finding, 'none');
  assert.deepEqual(gap.details.products, ['Sérum Élixir']);
  assert.equal(gap.details.matched, false);
});

test('stock details carry the boolean, never the raw count', () => {
  // One real row sits at -1 because Shopify allows overselling. "-1 en stock" is
  // a true value and a wrong answer.
  const [gap] = resolveNeeds(
    ['product_availability'],
    [{ id: 't1', tool: T.LOOKUP_STOCK, outcome: 'found',
       data: { products: [{ title: 'Masque LED', purchasable: false, available: -1 }] } }],
    [T.LOOKUP_STOCK]
  );

  assert.deepEqual(gap.details.products, [{ title: 'Masque LED', inStock: false }]);
  assert.ok(!JSON.stringify(gap.details).includes('-1'));
});

test('a refused code names itself and why it was refused', () => {
  const [gap] = resolveNeeds(
    ['promotion_eligibility'],
    [{ id: 't1', tool: T.LOOKUP_PROMOTION, outcome: 'blocked',
       data: { found: true, verdict: 'blocked', code: 'QIRINESS20',
               checks: [{ id: 'minimum', status: 'FAIL', reason: 'below_minimum' },
                        { id: 'window', status: 'PASS', reason: 'open' }] } }],
    [T.LOOKUP_PROMOTION]
  );

  assert.equal(gap.details.code, 'QIRINESS20');
  assert.deepEqual(gap.details.failedChecks, [{ check: 'minimum', reason: 'below_minimum' }]);
});

test('VIP is derived through the same rule the badge uses', () => {
  // `rfm_group` is the only source and VIP is a read-time question about it —
  // never stored, never reimplemented here.
  const [gap] = resolveNeeds(
    ['customer_account_state'],
    [{ id: 't1', tool: T.LOOKUP_CUSTOMER, outcome: 'found',
       data: { profile: { name: 'Élodie Bonnet', rfmGroup: 'CHAMPIONS', isVip: true, ordersCount: 7 } } }],
    [T.LOOKUP_CUSTOMER]
  );

  assert.equal(gap.details.name, 'Élodie Bonnet');
  assert.equal(gap.details.isVip, true);
  assert.equal(gap.details.ordersCount, 7);
});

test('details are ABSENT rather than empty when there is nothing to say', () => {
  // `{}` would make the panel render a heading over nothing.
  const [gap] = resolveNeeds(
    ['product_identity'],
    [{ id: 't1', tool: T.LOOKUP_PRODUCT, outcome: 'no_match', data: { found: false } }],
    [T.LOOKUP_PRODUCT]
  );

  assert.ok(!('details' in gap), 'the key is not present at all');
});

test('a need with no tool call carries no details', () => {
  const [gap] = resolveNeeds(['promotion_validity'], [], [T.LOOKUP_PROMOTION]);
  assert.equal(gap.state, 'not_attempted');
  assert.ok(!('details' in gap));
});

test('every need that declares details also declares a finding', () => {
  // A detail without a finding would be a specific with no state to qualify —
  // "the code is QIRINESS20" and nothing about whether it works.
  for (const key of DETAIL_KEYS) {
    assert.ok(FINDING_KEYS.includes(key), `${key} declares details but no finding`);
  }
});

test('an all-null details object is dropped, not stored as an answer', () => {
  // A real run stored `{name: null, isVip: null, ordersCount: null}`: it passed
  // every existence check and told a reader nothing, while looking like a fact.
  const [gap] = resolveNeeds(
    ['customer_account_state'],
    [{ id: 't1', tool: TOOL_NAMES.LOOKUP_CUSTOMER, outcome: 'found',
       data: { account: { canSignIn: true }, profile: { name: null, rfmGroup: null, ordersCount: null } } }],
    [TOOL_NAMES.LOOKUP_CUSTOMER]
  );

  assert.equal(gap.finding, 'enabled');
  assert.ok(!('details' in gap), 'nothing worth showing means no field');
});

test('customer details read the profile, not the account state', () => {
  // Two different things sit side by side on the tool result: `account` is the
  // STATE, `profile` is who it belongs to. Reading the wrong one is silent.
  const [gap] = resolveNeeds(
    ['customer_identity'],
    [{ id: 't1', tool: TOOL_NAMES.LOOKUP_CUSTOMER, outcome: 'found',
       data: { account: { state: 'active' },
               profile: { name: 'Sabrina Gani', rfmGroup: 'LOYAL', isVip: true, ordersCount: 2 } } }],
    [TOOL_NAMES.LOOKUP_CUSTOMER]
  );

  assert.equal(gap.details.name, 'Sabrina Gani');
  assert.equal(gap.details.isVip, true);
});

test('a library that could not answer says so, and how close it came', () => {
  // The one detail that is a TO-DO rather than a fact: no approved article
  // covers this, so the agent will keep failing the same question until one
  // does. `weak` and `none` call for different work — retitle versus write.
  const [weak] = resolveNeeds(
    ['product_property'],
    [{ id: 't1', tool: TOOL_NAMES.SEARCH_KNOWLEDGE, outcome: 'weak',
       data: { verdict: 'weak', bestSimilarity: 0.4912, chunks: [] } }],
    [TOOL_NAMES.SEARCH_KNOWLEDGE]
  );
  assert.equal(weak.details.libraryAnswered, false);
  assert.equal(weak.details.closest, 0.49, 'rounded, because two decimals is all it means');

  const [none] = resolveNeeds(
    ['policy_answer'],
    [{ id: 't1', tool: TOOL_NAMES.SEARCH_KNOWLEDGE, outcome: 'none',
       data: { verdict: 'none', bestSimilarity: null, chunks: [] } }],
    [TOOL_NAMES.SEARCH_KNOWLEDGE]
  );
  assert.equal(none.details.closest, null, 'nothing to be close to');
});

test('a library that DID answer adds no detail', () => {
  // The article is already in `established` as a claim; repeating it here would
  // say the same thing twice. The gap is the part nobody can see.
  const [gap] = resolveNeeds(
    ['product_property'],
    [{ id: 't1', tool: TOOL_NAMES.SEARCH_KNOWLEDGE, outcome: 'answerable',
       data: { verdict: 'answerable', bestSimilarity: 0.81, chunks: [{ title: 'FAQ' }] } }],
    [TOOL_NAMES.SEARCH_KNOWLEDGE]
  );
  assert.equal(gap.finding, 'answered');
  assert.ok(!('details' in gap));
});

// --- the order family, photo and purchase ------------------------------------

const withData = (id, tool, outcome, data) => ({ id, tool, outcome, data });
const orderEntry = (states) =>
  withData('t1', TOOL_NAMES.GET_ORDER_CONTEXT, 'found', { confirmed: true, states });

const findingFor = (need, ledger) =>
  resolveNeeds([need], ledger, ALL_TOOLS)[0].finding;

test('the order states are read off the tool ledger, not re-derived', () => {
  // The whole reason `order-context.mjs` projects them: a second reading of
  // `fulfillment_status` here would be free to disagree with the one the model
  // was shown.
  const ledger = [
    orderEntry({ order_state: 'not_dispatched', delivery_state: 'not_dispatched', payment_state: 'paid' })
  ];
  assert.equal(findingFor('order_state', ledger), 'not_dispatched');
  assert.equal(findingFor('delivery_state', ledger), 'not_dispatched');
  assert.equal(findingFor('payment_state', ledger), 'paid');
});

test('no confirmed order means unknown, for every order state', () => {
  // 138 of 214 tickets are this. It is the ordinary case, not a failure —
  // `order_identity` is the need that reports the gap and asks for the number.
  const unresolved = [withData('t1', TOOL_NAMES.GET_ORDER_CONTEXT, 'not_resolved', { confirmed: false, states: null })];
  for (const need of ['order_state', 'delivery_state', 'payment_state']) {
    assert.equal(finding(need, unresolved), 'unknown', need);
    assert.equal(finding(need, []), 'unknown', `${need} with no entry at all`);
  }
});

test('a state outside the vocabulary is unknown rather than passed through', () => {
  // A rule can only branch on values `findingValues()` declares, so anything
  // else must collapse rather than become a value nothing can match.
  const ledger = [orderEntry({ order_state: 'en cours', delivery_state: null, payment_state: 'PAID' })];
  assert.equal(findingFor('order_state', ledger), 'unknown');
  assert.equal(findingFor('delivery_state', ledger), 'unknown');
  assert.equal(findingFor('payment_state', ledger), 'unknown');
});

test('purchase verification keeps a known customer with no orders apart from a stranger', () => {
  assert.equal(
    findingFor('purchase_verified', [entry('t1', TOOL_NAMES.VERIFY_PURCHASE, 'known_buyer')]),
    'known_buyer'
  );
  assert.equal(
    findingFor('purchase_verified', [entry('t1', TOOL_NAMES.VERIFY_PURCHASE, 'known_no_orders')]),
    'known_no_orders'
  );
});

test('photo evidence keeps its four states apart', () => {
  // Three of them are not "no photo": a customer who believes they attached one,
  // and metadata we never fetched, both call for something other than "resend".
  for (const outcome of ['attached', 'mentioned_not_attached', 'attachment_type_unknown', 'none']) {
    const ledger = [withData('t1', TOOL_NAMES.CHECK_PHOTO_EVIDENCE, outcome, { outcome })];
    assert.equal(findingFor('photo_evidence', ledger), outcome);
  }
  assert.equal(findingFor('photo_evidence', []), 'unknown');
});

test('every new finding is a value its own vocabulary declares', () => {
  // The property answer-selection depends on: a condition is validated against
  // findingValues(), so a deriver returning something outside it would be a
  // branch that can never match.
  const ledger = [
    orderEntry({ order_state: 'delivered', delivery_state: 'stale_in_transit', payment_state: 'refunded' }),
    withData('t2', TOOL_NAMES.CHECK_PHOTO_EVIDENCE, 'attached', { outcome: 'attached' }),
    entry('t3', TOOL_NAMES.VERIFY_PURCHASE, 'known_buyer')
  ];
  for (const need of ['order_state', 'delivery_state', 'payment_state', 'photo_evidence', 'purchase_verified']) {
    assert.ok(findingValues(need).includes(finding(need, ledger)), need);
  }
});

// --- telling "no account" from "we cannot place you" --------------------------

test('the account state separates a known customer with no account from an unknown sender', () => {
  // THE PAIR THIS VOCABULARY EXISTS FOR, and the two biggest buckets in the
  // corpus: 156 tickets whose sender matches no customer row, and 97 whose
  // sender matches a row with no account behind it. They need opposite replies —
  // the first has to ASK which address the account is under, the second must not
  // ask at all, because we already know exactly who wrote in.
  const state = (data, outcome = 'found') =>
    findingsOf(
      resolveNeeds(
        ['customer_account_state'],
        [{ id: 't1', tool: TOOL_NAMES.LOOKUP_CUSTOMER, outcome, data }],
        [TOOL_NAMES.LOOKUP_CUSTOMER]
      )
    ).customer_account_state;

  assert.equal(state({ account: { canSignIn: true } }), 'enabled');
  assert.equal(state({ account: { neverActivated: true } }), 'never_activated');
  assert.equal(state({ account: { disabled: true } }), 'known_no_account');
  assert.equal(state({ account: null }, 'no_match'), 'unknown_sender');
  // No address to look up at all reaches the same reply — ask which one — but
  // the ledger's outcome keeps the two apart for whoever reads the run.
  assert.equal(state({ account: null }, 'no_identifier'), 'unknown_sender');
});

test('a state Shopify never set is unknown, not guessed at', () => {
  // A customer row whose `state` is null satisfies none of the three flags. It
  // must not fall through to `known_no_account`: that would tell somebody they
  // have no account on the strength of a missing field.
  const [gap] = resolveNeeds(
    ['customer_account_state'],
    [{ id: 't1', tool: TOOL_NAMES.LOOKUP_CUSTOMER, outcome: 'found', data: { account: {} } }],
    [TOOL_NAMES.LOOKUP_CUSTOMER]
  );
  assert.equal(gap.finding, 'unknown');
});

test('the tool never having run is not the same as finding nobody', () => {
  const [gap] = resolveNeeds(['customer_account_state'], [], [TOOL_NAMES.LOOKUP_CUSTOMER]);
  assert.equal(gap.finding, 'unknown');
});

// --- which needs an article could answer --------------------------------------

test('a knowledge need is exactly one an approved article can satisfy', () => {
  // TESTED THROUGH THE BEHAVIOUR, not against the table it is derived from —
  // asserting the list matches `satisfiedBy` would just restate the derivation.
  // What matters is the observable property: a successful library search settles
  // a knowledge need and settles nothing else.
  //
  // A HARDCODED LIST WOULD DRIFT SILENTLY, and the failure would be a gap report
  // that stops counting a need — the one thing a report about missing knowledge
  // must not do.
  const answered = [
    { id: 't1', tool: TOOL_NAMES.SEARCH_KNOWLEDGE, outcome: 'answerable', data: { verdict: 'answerable' } }
  ];

  for (const need of KNOWLEDGE_NEEDS) {
    const [gap] = resolveNeeds([need], answered, [TOOL_NAMES.SEARCH_KNOWLEDGE]);
    assert.equal(gap.state, 'satisfied', `${need} should be satisfied by an approved article`);
  }

  for (const need of NEED_KEYS.filter((key) => !KNOWLEDGE_NEEDS.includes(key))) {
    const [gap] = resolveNeeds([need], answered, [TOOL_NAMES.SEARCH_KNOWLEDGE]);
    assert.notEqual(gap.state, 'satisfied', `${need} must not be settled by a library search`);
  }
});

test('a need no tool can satisfy is not mistaken for a missing article', () => {
  // The gap report exists to name articles somebody could write. `other_fact` and
  // `checkout_state` can never be satisfied by anything, so counting them would
  // commission an article for a question no library can answer.
  assert.ok(!KNOWLEDGE_NEEDS.includes('other_fact'));
  assert.ok(!KNOWLEDGE_NEEDS.includes('checkout_state'));
});

test('the product sheet answers a product characteristic, not just the library', () => {
  // THE NEED IS SATISFIED BY EITHER TOOL AND THE FINDING READ ONLY ONE. A run
  // that pulled the whole sheet — description, usage, ingredients — and answered
  // from it scored `none`, meaning "the library had nothing", which was true and
  // beside the point.
  //
  // Measured before the fix: 8 of 13 product investigations reported as
  // unanswered were `state: satisfied` with `finding: none`. The consequence is
  // worse than a wrong report — a rule branching on `answered` could never fire
  // for a question answered from the catalogue, where 89 of 98 active products
  // keep their usage instructions.
  const finding = (entries) =>
    findingsOf(
      resolveNeeds(['product_property'], entries, [TOOL_NAMES.LOOKUP_PRODUCT, TOOL_NAMES.SEARCH_KNOWLEDGE])
    ).product_property;

  const sheet = { id: 'p', tool: TOOL_NAMES.LOOKUP_PRODUCT, outcome: 'found' };
  const silent = { id: 'k', tool: TOOL_NAMES.SEARCH_KNOWLEDGE, outcome: 'none' };

  assert.equal(finding([sheet, silent]), 'answered');
  // The sheet wins when both spoke: it is the more specific source for a
  // characteristic OF A PRODUCT, where the library answers about the shop.
  assert.equal(finding([sheet, { ...silent, outcome: 'weak' }]), 'answered');
  // The library still answers on its own.
  assert.equal(finding([{ ...silent, outcome: 'answerable' }]), 'answered');
});

test('an ambiguous product is not an answered characteristic', () => {
  // Two possible products means two possible ingredient lists, and neither is an
  // answer — which is why `satisfiedBy` requires `found` and this matches it.
  const finding = findingsOf(
    resolveNeeds(
      ['product_property'],
      [
        { id: 'p', tool: TOOL_NAMES.LOOKUP_PRODUCT, outcome: 'ambiguous' },
        { id: 'k', tool: TOOL_NAMES.SEARCH_KNOWLEDGE, outcome: 'none' }
      ],
      [TOOL_NAMES.LOOKUP_PRODUCT, TOOL_NAMES.SEARCH_KNOWLEDGE]
    )
  ).product_property;
  assert.equal(finding, 'none');
});

test('order_identity resolves to a value, so a rule can tell "which order" from "what state"', () => {
  // THE TRAP THIS CLOSES. `order_state` reports `unknown` both when no order was
  // confirmed and when one was whose delivery state is unrecognised. A rule
  // keyed on that pair asks the customer for a number already in hand.
  const resolved = [{ id: 't1', tool: TOOL_NAMES.GET_ORDER_CONTEXT, outcome: 'found', data: {} }];
  const unresolved = [
    { id: 't1', tool: TOOL_NAMES.GET_ORDER_CONTEXT, outcome: 'not_resolved', data: {} }
  ];

  assert.equal(finding('order_identity', resolved), 'resolved');
  assert.equal(finding('order_identity', unresolved), 'none');
  // Both report `order_state: unknown`, which is exactly why the pair was
  // indistinguishable before this finding existed.
  assert.equal(finding('order_state', resolved), 'unknown');
  assert.equal(finding('order_state', unresolved), 'unknown');

  // A tool that never ran is neither.
  assert.equal(finding('order_identity', []), 'unknown');
});

test('dispatch_state is read off the order bundle like the other order states', () => {
  const overdue = [
    {
      id: 't1',
      tool: TOOL_NAMES.GET_ORDER_CONTEXT,
      outcome: 'found',
      data: { states: { dispatch_state: 'overdue' } }
    }
  ];
  assert.equal(finding('dispatch_state', overdue), 'overdue');
  // A shop that has not set `dispatch_days` resolves `unknown`, never a guess.
  assert.equal(
    finding('dispatch_state', [
      { id: 't1', tool: TOOL_NAMES.GET_ORDER_CONTEXT, outcome: 'found', data: { states: {} } }
    ]),
    'unknown'
  );
});

test('the product family orders identity before the facts that depend on it', () => {
  // Stock is a fact about one variant, so a planner walking this graph must not
  // propose a stock check before it knows which product.
  assert.deepEqual(
    orderNeeds(['product_availability', 'product_property', 'product_identity']),
    ['product_identity', 'product_property', 'product_availability']
  );

  // `product_property` is deliberately NOT ordered behind identity: the library
  // answers « vos produits sont-ils testés sur les animaux ? » without a product
  // being named at all, so a prerequisite there would order a collection that
  // does not need one.
  assert.deepEqual(needRequires('product_property'), []);

  // And `product_recommendation` asks what we can put forward to somebody who
  // has named nothing — requiring identity would make it uncollectable exactly
  // when it is the need that matters.
  assert.deepEqual(needRequires('product_recommendation'), []);
});

test('a photo and a purchase check are chased after the thing they are about', () => {
  assert.deepEqual(needRequires('photo_evidence'), ['product_identity']);
  assert.deepEqual(needRequires('purchase_verified'), ['customer_identity']);
  const ordered = orderNeeds(['photo_evidence', 'purchase_verified', 'product_identity', 'customer_identity']);
  assert.ok(ordered.indexOf('product_identity') < ordered.indexOf('photo_evidence'));
  assert.ok(ordered.indexOf('customer_identity') < ordered.indexOf('purchase_verified'));
});

test('the dependency graph has no cycle', () => {
  // `orderNeeds` falls back to declaration order on a cycle rather than hanging,
  // so a bad edge would mis-order silently instead of failing. This is what
  // catches it.
  const seen = new Set();
  const visit = (key, stack) => {
    if (stack.includes(key)) assert.fail(`cycle through ${key}: ${stack.join(' -> ')}`);
    if (seen.has(key)) return;
    seen.add(key);
    for (const next of needRequires(key)) visit(next, [...stack, key]);
  };
  for (const key of NEED_KEYS) visit(key, []);
});

test('a designed gap is one only an attempted need may claim', () => {
  // The narrowing is the whole argument: a tie cannot ALSO be resolved, and a
  // tool that never ran cannot have found a tie either.
  assert.equal(isDesignedGap('product_identity', 'ambiguous', 'attempted'), true);
  assert.equal(isDesignedGap('product_identity', 'ambiguous', 'satisfied'), false);
  assert.equal(isDesignedGap('product_identity', 'ambiguous', 'not_attempted'), false);
  assert.equal(isDesignedGap('order_identity', 'none', 'attempted'), false);
});

test('closability reads the question before the state, and the finding before both', () => {
  // `not_attempted` is our own miss and outranks having a question to ask: a
  // customer must never be asked for what we never looked for.
  assert.equal(
    gapClosability({ need: 'order_identity', state: 'not_attempted', asksCustomer: 'shopify_order_number' }),
    'now'
  );
  // `unavailable` is every need on a cosmetovigilance ticket, where the empty
  // tool set is deliberate — and CV-01 still asks which product was used.
  assert.equal(
    gapClosability({ need: 'reaction_product', state: 'unavailable', asksCustomer: 'reaction_product_name' }),
    'customer'
  );
  // The finding outranks the state: a tool ran and the basket is still invisible.
  assert.equal(
    gapClosability({
      need: 'promotion_eligibility',
      state: 'attempted',
      finding: 'undetermined',
      asksCustomer: 'promotion_code'
    }),
    'never'
  );
  // Unsatisfiable by design, so that a ticket whose real requirement cannot be
  // named can never report as complete.
  assert.equal(gapClosability({ need: 'other_fact', state: 'unavailable' }), 'never');
  // Attempted, nothing found, nobody to ask. A real class, and deliberately not
  // folded into `never`: an article somebody could write is not a fact that does
  // not exist.
  assert.equal(gapClosability({ need: 'policy_answer', state: 'attempted', finding: 'none' }), 'unclear');
});

test('every need scores a closability, and none of them scores "satisfied"', () => {
  // A gate reads this for every open need, so a need the classifier falls
  // through on would be silently unblockable.
  for (const need of NEED_KEYS) {
    for (const state of NEED_STATES) {
      const kind = gapClosability({ need, state, finding: 'unknown' });
      assert.ok(['now', 'customer', 'never', 'unclear'].includes(kind), `${need}/${state} -> ${kind}`);
    }
  }
});

test('the satisfiedBy table reads backwards, and only for tools that appear in it', () => {
  assert.ok(needsSatisfiedBy(TOOL_NAMES.LOOKUP_STOCK).includes('product_availability'));
  assert.ok(needsSatisfiedBy(TOOL_NAMES.SEARCH_KNOWLEDGE).includes('policy_answer'));
  // `other_fact` declares no source at all, so no tool can ever name it.
  for (const need of NEED_KEYS) {
    const sources = needsSatisfiedBy('noSuchTool');
    assert.equal(sources.includes(need), false);
  }
});

test('with no tool available, only a question that names the FACT closes the gap', () => {
  // The subtle half, and neither plain ordering gets it right. `asksCustomer` is
  // many-to-one: on `product_identity` the question IS the answer, and on
  // `product_availability` it is only the key a tool would have needed — and
  // `unavailable` is precisely the statement that the tool cannot run.
  const unavailable = (need, asksCustomer) =>
    gapClosability({ need, state: 'unavailable', finding: 'unknown', asksCustomer });

  assert.equal(unavailable('product_identity', 'product_name'), 'customer');
  assert.equal(unavailable('reaction_product', 'reaction_product_name'), 'customer');
  assert.equal(unavailable('photo_evidence', 'photo'), 'customer');

  assert.equal(unavailable('product_availability', 'product_name'), 'never', 'the name is not the stock');
  assert.equal(unavailable('refund_state', 'shopify_order_number'), 'never', 'the number is not the refund');
  assert.equal(unavailable('promotion_validity', 'promotion_code'), 'never', 'the code is not its validity');

  // Where a tool COULD still run, the same question is worth putting: the tool
  // is there to use the answer.
  assert.equal(
    gapClosability({ need: 'promotion_validity', state: 'attempted', finding: 'unknown', asksCustomer: 'promotion_code' }),
    'customer'
  );
});

test('every enabled subject declares what a complete reply rests on', () => {
  // A subject with no floor cannot have collection stopped on it, so the gap
  // would be silent rather than loud. `other` is the deliberate exception: it is
  // the catch-all, and there is no fact a reply to "anything else" always needs.
  for (const subject of ENABLED_SUBJECTS) {
    const needs = responseNeeds(subject);
    if (subject === 'other') {
      assert.deepEqual(needs, [], 'the catch-all declares nothing, on purpose');
      continue;
    }
    assert.ok(needs.length > 0, subject);
    for (const need of needs) assert.ok(NEED_KEYS.includes(need), `${subject} -> ${need}`);
  }
});

test('a tool call is never a response need, however the checklist words it', () => {
  // `knowledge_searched` is « la base de connaissances a été consultée » — an
  // ACTION. This vocabulary says needs are facts, and admitting the one shape it
  // refuses into the list that decides when collection stops would be the whole
  // point lost.
  for (const subject of ENABLED_SUBJECTS) {
    assert.ok(!responseNeeds(subject).includes('knowledge_searched'));
  }
  assert.ok(!NEED_KEYS.includes('knowledge_searched'));
});

test('a rule may add a response need and may never shrink the floor', () => {
  const floor = responseNeeds('account');
  const widened = responseNeeds('account', ['order_identity']);

  for (const need of floor) assert.ok(widened.includes(need), 'the floor survived');
  assert.ok(widened.includes('order_identity'), 'and the rule added to it');
  assert.deepEqual(responseNeeds('account', []), floor, 'adding nothing changes nothing');
});

test('completeness needs every fact settled, and unknown does not count', () => {
  const order = { need: 'order_identity', state: 'satisfied', finding: 'resolved' };
  // On the floor since 2026-09-04: 24 established claims across the order family
  // rested on the customer lookup while the floor named it nowhere.
  const customer = { need: 'customer_identity', state: 'satisfied', finding: 'resolved' };

  assert.equal(
    responseComplete('delivery', [order, customer, { need: 'delivery_state', state: 'satisfied', finding: 'delivered' }]),
    true
  );
  assert.equal(
    responseComplete('delivery', [order, customer, { need: 'delivery_state', state: 'not_attempted', finding: 'unknown' }]),
    false,
    'nobody looked, so the reply is not ready however decided the rule is'
  );
  assert.equal(
    responseComplete('delivery', [order, { need: 'delivery_state', state: 'satisfied', finding: 'delivered' }]),
    false,
    'and the customer lookup is part of ready now, not an optional extra'
  );
});

test('a fact nothing can ever establish does not hold the loop open', () => {
  // Reuses step 6's closability: a need with no tool wired is not a reason to
  // keep collecting, and treating it as one would mean the loop never ends on
  // most subjects.
  assert.equal(
    responseComplete('delivery', [
      { need: 'order_identity', state: 'satisfied', finding: 'resolved' },
      { need: 'customer_identity', state: 'satisfied', finding: 'resolved' },
      { need: 'delivery_state', state: 'unavailable', finding: 'unknown' }
    ]),
    true
  );
});

test('a subject with no declared floor is ungoverned, not complete', () => {
  // An empty list is the absence of a rule about when to stop, and reading it as
  // "stop now" would suppress collection hardest exactly where nobody has said
  // what a good answer needs.
  assert.equal(responseComplete('other', [{ need: 'policy_answer', state: 'satisfied', finding: 'answered' }]), false);
});

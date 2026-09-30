import assert from 'node:assert/strict';
import test from 'node:test';

import { companyPoliciesUsed } from './company-policy-use.mjs';

const LIBRARY = {
  policies: [
    { id: 'p1', policy_key: 'delivery_time_policy', version: 3, active: true },
    { id: 'p2', policy_key: 'delivery_location_policy', version: 1, active: true },
    { id: 'p3', policy_key: 'refund_policy', version: 2, active: true }
  ],
  links: [
    { policy_id: 'p1', situation_key: 'D-07', answer_id: null },
    { policy_id: 'p2', situation_key: null, answer_id: 'a-1' },
    { policy_id: 'p1', situation_key: null, answer_id: 'a-1' }
  ]
};
const REQUESTS = [{ answerSet: 'commande', situationKey: 'D-07', answers: [{ id: 'a-1', answerKey: 'd07_delais' }, { id: 'a-2', answerKey: 'other' }] }];

test("the situation's policies, then the selected rule's, then what the agent fetched, each once", () => {
  const used = companyPoliciesUsed({
    library: LIBRARY,
    requests: REQUESTS,
    selection: { answer_set: 'commande', answer_key: 'd07_delais' },
    ledger: [
      { tool: 'getPolicy', outcome: 'found', data: { key: 'delivery_time_policy', version: 3 } },
      { tool: 'getPolicy', outcome: 'found', data: { key: 'refund_policy', version: 2 } },
      { tool: 'getPolicy', outcome: 'unknown_key', data: { key: 'nope', version: null } }
    ]
  });
  assert.deepEqual(used, [
    { key: 'delivery_time_policy', version: 3, source: 'situation' },
    { key: 'delivery_location_policy', version: 1, source: 'rule' },
    { key: 'refund_policy', version: 2, source: 'agent' }
  ]);
});

test('a rule that was not selected contributes nothing, and no library means nothing', () => {
  const used = companyPoliciesUsed({ library: LIBRARY, requests: [{ ...REQUESTS[0], situationKey: null }], selection: { answer_set: 'commande', answer_key: 'other' } });
  assert.deepEqual(used, []);
  assert.deepEqual(companyPoliciesUsed({ library: { policies: [], links: [] }, requests: REQUESTS }), []);
});

test('a combined selection reads the rule of every request', () => {
  const used = companyPoliciesUsed({
    library: LIBRARY,
    requests: [{ ...REQUESTS[0], situationKey: null }],
    selection: { per_request: [{ answer_set: 'commande', answer_key: 'd07_delais' }] }
  });
  assert.deepEqual(used.map((u) => u.key), ['delivery_location_policy', 'delivery_time_policy']);
});

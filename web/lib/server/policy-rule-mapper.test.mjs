import assert from 'node:assert/strict';
import test from 'node:test';

import { mapPolicyRule } from './policy-rule-mapper.mjs';

test('a migration-59 rule reaches the editor without legacy order_identity none', () => {
  const rule = mapPolicyRule({
    id: 'd01-rule',
    answer_set: 'orders',
    answer_key: 'commande_non_identifiee',
    situation_key: 'D-01',
    when_conditions: {
      order_identity: [
        'none',
        'no_number_known_sender',
        'no_number_unknown_sender',
        'number_not_found',
        'other_email_same_name',
        'other_email'
      ]
    },
    ask: ['shopify_order_number'],
    approval_status: 'approved'
  });

  assert.deepEqual(rule.conditions, {
    order_identity: [
      'no_number_known_sender',
      'no_number_unknown_sender',
      'number_not_found',
      'other_email_same_name',
      'other_email'
    ]
  });
  assert.equal(rule.conditions.order_identity.includes('none'), false);
});

test('the refund-notice flag reaches the editor, and reads null on every other rule', () => {
  const base = { id: 'r1', answer_set: 'returns', answer_key: 'remboursement_deja_parti', when_conditions: {}, approval_status: 'approved' };
  assert.equal(mapPolicyRule({ ...base, notify_on: 'refund_recorded' }).notifyOn, 'refund_recorded');
  assert.equal(mapPolicyRule(base).notifyOn, null);
});

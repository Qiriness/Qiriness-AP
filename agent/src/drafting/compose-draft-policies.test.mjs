import assert from 'node:assert/strict';
import test from 'node:test';

import { caseFileFromRow, composeDraftingMessage, promptInputs } from './compose-draft.mjs';

const ROW = {
  verdict: 'answerable',
  established: [],
  company_policies: [
    { key: 'delivery_time_policy', version: 2, source: 'situation' },
    { key: 'refund_policy', version: 1, source: 'agent' },
    { key: 'switched_off', version: 1, source: 'rule' }
  ]
};
const LIBRARY = new Map([
  ['delivery_time_policy', { policy_key: 'delivery_time_policy', name: 'Délais', content: 'Expédié sous {dispatch_days} jours.', version: 3, active: true }],
  ['refund_policy', { policy_key: 'refund_policy', name: 'Remboursements', content: 'Sous {returns_window_days} jours.', version: 1, active: true }]
]);
const PARAMETERS = new Map([['dispatch_days', '2']]);
const MESSAGE = { subject: 'Délais', body_text: 'Combien de temps pour être livré ?' };

test("the case's policies reach the prompt with their current text, under one instruction", () => {
  const text = composeDraftingMessage({ message: MESSAGE, caseFile: caseFileFromRow(ROW), companyPolicies: LIBRARY, parameters: PARAMETERS });
  assert.match(text, /## Politiques de l'entreprise\n\nUtilise les passages de ces politiques/);
  assert.match(text, /### Délais\nExpédié sous 2 jours\./);
  // Unset parameter: withheld rather than shown with a brace. Switched off: dropped.
  assert.doesNotMatch(text, /Remboursements|returns_window_days|switched_off/);
});

test('no policies, no section: a case written before policies drafts as it did', () => {
  const text = composeDraftingMessage({ message: MESSAGE, caseFile: caseFileFromRow({ verdict: 'answerable' }), companyPolicies: LIBRARY });
  assert.doesNotMatch(text, /Politiques de l'entreprise/);
});

test('the draft records which version of each policy it was written with', () => {
  const inputs = promptInputs({ caseFile: caseFileFromRow(ROW), investigationId: 'i', model: 'm', companyPolicies: LIBRARY, parameters: PARAMETERS });
  assert.deepEqual(inputs.company_policies, [{ key: 'delivery_time_policy', version: 3, source: 'situation' }]);
  assert.equal(promptInputs({ caseFile: caseFileFromRow(ROW), investigationId: 'i', model: 'm' }).company_policies, undefined);
});
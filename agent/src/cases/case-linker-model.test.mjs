import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLinkerUser, createCaseLinker, linkerSchema, parseLinkerAnswer } from './case-linker-model.mjs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

test('only LINK:<a shown case> or NEW_CASE count; anything else is a new case', () => {
  assert.deepEqual(parseLinkerAnswer(`LINK:${A}`, [A, B]), { decision: 'link', caseId: A });
  assert.deepEqual(parseLinkerAnswer('NEW_CASE', [A]), { decision: 'new_case', caseId: null });
  assert.equal(parseLinkerAnswer(`LINK:${'3'.repeat(8)}-3333-4333-8333-333333333333`, [A]).decision, 'new_case');
  assert.equal(parseLinkerAnswer('LINK: the first one', [A]).decision, 'new_case');
  assert.equal(parseLinkerAnswer(null, [A]).decision, 'new_case');
  assert.equal(parseLinkerAnswer('', [A]).malformed, true);
});

test('the schema can only name the cases shown, or NEW_CASE', () => {
  assert.deepEqual(linkerSchema([A, B]).properties.answer.enum, [`LINK:${A}`, `LINK:${B}`, 'NEW_CASE']);
});

test('the prompt carries identifiers and candidates, and no name or address', () => {
  const user = buildLinkerUser({
    subject: 'Toujours rien',
    body: 'Je n’ai toujours pas reçu ma commande',
    identifiers: { orderNumber: '#5832', trackingNumbers: [], family: 'DELIVERY' },
    candidates: [{ caseId: A, family: 'DELIVERY', situationKey: 'D-01', orderNumbers: ['#5832'], trackingNumbers: [], summary: 'Où est ma commande [open]', opening: 'Bonjour, ma commande 5832 n’est pas arrivée', reasons: ['same_order'] }]
  });
  assert.match(user, /Commande : #5832/);
  assert.match(user, new RegExp(`\\[${A}\\]`));
  assert.match(user, /Situation : D-01/);
  assert.match(user, /Premier message du client : Bonjour, ma commande 5832/);
  assert.doesNotMatch(user, /@/);
});

test('the call is costed under its own pass', async () => {
  const calls = [];
  const linkCase = createCaseLinker(
    { completeJson: async (request) => (calls.push(request), { answer: `LINK:${A}` }) },
    { model: 'gpt-4o-mini' }
  );
  const result = await linkCase({ ticketId: 't1', subject: 's', body: 'b', identifiers: {}, candidates: [{ caseId: A }] });
  assert.equal(calls[0].pass, 'case_link');
  assert.deepEqual(result, { decision: 'link', caseId: A, answer: `LINK:${A}`, model: 'gpt-4o-mini' });
});

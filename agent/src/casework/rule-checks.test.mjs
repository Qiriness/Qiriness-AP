import assert from 'node:assert/strict';
import test from 'node:test';

import { foldCase } from './case-fold.mjs';
import { checkProblems, normaliseChecks, sequencesOf } from './rule-checks.mjs';
import { answerFromRow } from '../investigation/answer-selection.mjs';

// D-36, « the customer wants out »: ask Deret where the parcel is, then settle
// the refund. The shape the plan was written for.
const D36 = [{ owner: 'partner', need: 'delivery_state' }, { owner: 'support', need: 'refund_state' }];

const msg = (id, actor, at) => ({ id, actor, direction: actor === 'support' ? 'outbound' : 'inbound', received_at: at });
const caseFile = (trigger, steps = D36) => ({
  trigger_message_id: trigger,
  verdict: 'needs_human',
  missing: [],
  investigated_at: '2026-09-01T10:05:00Z',
  check_sequences: [{ answer_key: 'retard_client_veut_sortir', steps }]
});
const byStep = (state) => Object.fromEntries(state.obligations.filter((o) => o.rule).map((o) => [o.step, o]));

test('the rule opens its first check and queues the rest', () => {
  const state = foldCase({ messages: [msg('m1', 'customer', '2026-09-01T10:00:00Z')], caseFiles: [caseFile('m1')] });
  const steps = byStep(state);
  assert.equal(steps[1].status, 'pending');
  assert.equal(steps[1].owner, 'partner');
  assert.equal(steps[1].opened_at, '2026-09-01T10:05:00Z');
  assert.equal(steps[2].status, 'queued');
  // The customer spoke last: we still owe them a reply.
  assert.equal(state.next_actor, 'support');
});

test('after our reply the case waits on the operations partner, not on nobody', () => {
  const state = foldCase({
    messages: [msg('m1', 'customer', '2026-09-01T10:00:00Z'), msg('m2', 'support', '2026-09-01T11:00:00Z')],
    caseFiles: [caseFile('m1')]
  });
  assert.equal(state.next_actor, 'partner');
  assert.equal(state.resolved, false);
});

test('« Mark done » on step 1 opens step 2 from that moment', () => {
  const messages = [msg('m1', 'customer', '2026-09-01T10:00:00Z'), msg('m2', 'support', '2026-09-01T11:00:00Z')];
  const first = byStep(foldCase({ messages, caseFiles: [caseFile('m1')] }))[1];
  const state = foldCase({
    messages,
    caseFiles: [caseFile('m1')],
    actions: [{ obligation_id: first.id, action: 'fulfilled', acted_by: 'u1', acted_at: '2026-09-02T09:00:00Z' }]
  });
  const steps = byStep(state);
  assert.equal(steps[1].status, 'fulfilled');
  assert.equal(steps[2].status, 'pending');
  assert.equal(steps[2].opened_at, '2026-09-02T09:00:00Z');
  assert.equal(state.next_actor, 'support');
});

test('« No longer needed » on a step ends the sequence', () => {
  const messages = [msg('m1', 'customer', '2026-09-01T10:00:00Z'), msg('m2', 'support', '2026-09-01T11:00:00Z')];
  const first = byStep(foldCase({ messages, caseFiles: [caseFile('m1')] }))[1];
  const state = foldCase({
    messages,
    caseFiles: [caseFile('m1')],
    actions: [{ obligation_id: first.id, action: 'cancelled', acted_by: 'u1', acted_at: '2026-09-02T09:00:00Z' }]
  });
  assert.deepEqual(state.obligations.map((o) => [o.step, o.status]), [[1, 'cancelled']]);
  assert.equal(state.next_actor, 'nobody');
});

test('the partner answering, read as clearing step 1, opens step 2 at their message', () => {
  const messages = [
    msg('m1', 'customer', '2026-09-01T10:00:00Z'),
    msg('m2', 'support', '2026-09-01T11:00:00Z'),
    msg('m3', 'partner', '2026-09-03T08:00:00Z')
  ];
  const first = byStep(foldCase({ messages, caseFiles: [caseFile('m1')] }))[1];
  const state = foldCase({
    messages,
    caseFiles: [caseFile('m1')],
    readings: [{ trigger_message_id: 'm3', effect: 'answers', obligations_cleared: [first.id] }]
  });
  const steps = byStep(state);
  assert.equal(steps[1].status, 'fulfilled');
  assert.equal(steps[2].status, 'pending');
  assert.equal(steps[2].opened_at, '2026-09-03T08:00:00Z');
  assert.equal(state.next_actor, 'support');
});

test('a check someone already opened is adopted, not duplicated', () => {
  // « je transmets à Deret » in our reply, read before the investigation ran.
  const messages = [msg('m1', 'customer', '2026-09-01T10:00:00Z'), msg('m2', 'support', '2026-09-01T11:00:00Z')];
  const state = foldCase({
    messages,
    caseFiles: [caseFile('m2')],
    readings: [{ trigger_message_id: 'm2', effect: 'answers', obligations_opened: [{ owner: 'partner', need: 'delivery_state' }] }]
  });
  const partner = state.obligations.filter((o) => o.owner === 'partner');
  assert.equal(partner.length, 1);
  assert.equal(partner[0].id, 'o-m2-0');
  assert.equal(partner[0].step, 1);
  assert.equal(byStep(state)[2].status, 'queued');
});

test('a check already settled in the thread counts as the step done: Deret is not asked twice', () => {
  const messages = [
    msg('m1', 'customer', '2026-09-01T10:00:00Z'),
    msg('m2', 'support', '2026-09-01T11:00:00Z'),
    msg('m3', 'partner', '2026-09-02T08:00:00Z'),
    msg('m4', 'customer', '2026-09-03T10:00:00Z')
  ];
  const state = foldCase({
    messages,
    caseFiles: [caseFile('m4')],
    readings: [
      { trigger_message_id: 'm2', effect: 'answers', obligations_opened: [{ owner: 'partner', need: 'delivery_state' }] },
      { trigger_message_id: 'm3', effect: 'answers', obligations_cleared: ['o-m2-0'] }
    ]
  });
  const steps = byStep(state);
  assert.equal(steps[1].id, 'o-m2-0');
  assert.equal(steps[1].status, 'fulfilled');
  assert.equal(steps[2].status, 'pending');
  assert.equal(state.obligations.filter((o) => o.owner === 'partner').length, 1);
});

test('a case file with no checks folds exactly as before', () => {
  const messages = [msg('m1', 'customer', '2026-09-01T10:00:00Z'), msg('m2', 'support', '2026-09-01T11:00:00Z')];
  const plain = { trigger_message_id: 'm1', verdict: 'needs_human', missing: [] };
  assert.deepEqual(foldCase({ messages, caseFiles: [plain] }), foldCase({ messages, caseFiles: [{ ...plain, check_sequences: null }] }));
  assert.equal(foldCase({ messages, caseFiles: [plain] }).next_actor, 'nobody');
});

test('folding twice gives the same ids, so the version does not move', () => {
  const input = { messages: [msg('m1', 'customer', '2026-09-01T10:00:00Z')], caseFiles: [caseFile('m1')] };
  assert.equal(foldCase(input).material_hash, foldCase(input).material_hash);
});

test('steps are checked against the closed lists and the brand’s owners', () => {
  assert.deepEqual(normaliseChecks([...D36, { owner: 'customer', need: 'delivery_state' }, { owner: 'support', need: 'nope' }]), D36);
  assert.deepEqual(normaliseChecks('x'), []);
  assert.deepEqual(checkProblems(D36, { owners: ['support', 'colleague', 'partner'] }), []);
  assert.deepEqual(checkProblems(D36, { owners: ['support'] }), ['Step 1: this brand has no operations partner in its sender directory.']);
  assert.deepEqual(checkProblems([{ owner: 'support' }]), ['Step 1: choose what is to be checked.']);
  assert.equal(checkProblems(Array(6).fill(D36[1]))[0], 'At most 5 steps.');
});

test('a rule row carries its checks; a case file hands them to the fold', () => {
  assert.deepEqual(answerFromRow({ answer_key: 'k', checks: D36 }).checks, D36);
  assert.deepEqual(answerFromRow({ answer_key: 'k' }).checks, []);
  assert.deepEqual(sequencesOf(caseFile('m1')), [{ answerKey: 'retard_client_veut_sortir', steps: D36 }]);
  assert.deepEqual(sequencesOf({ exemplar_match: { policy: { check_sequences: [{ answer_key: 'x', steps: [] }] } } }), []);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildUserPrompt, createDestinationChooser, planRoute } from './destination-router.mjs';

const dest = (label, categories, extra = {}) => ({
  label,
  forward_email: `${label.toLowerCase()}@example.com`,
  active_since: '2026-09-29T00:00:00Z',
  description: `${label} handles things`,
  categories,
  request_kinds: [],
  match_description: false,
  ...extra
});

const DESTINATIONS = [
  dest('Careers', ['careers']),
  dest('Accounting', ['b2b']),
  dest('Export', ['b2b']),
  dest('Defects', ['product'], { forward_email: null, match_description: true })
];

test('one destination on the category is taken without the model', () => {
  const plan = planRoute({ ticket: { category: 'careers', request_kind: 'contact' }, destinations: DESTINATIONS });
  assert.equal(plan.route, 'fixed');
  assert.deepEqual(plan.candidates.map((d) => d.label), ['Careers']);
});

test('several destinations make it a choice', () => {
  const plan = planRoute({ ticket: { category: 'b2b', request_kind: 'problem' }, destinations: DESTINATIONS });
  assert.equal(plan.route, 'choose');
  assert.deepEqual(plan.candidates.map((d) => d.label), ['Accounting', 'Export']);
});

test('a switched-off destination routes nothing, and an unconfigured category stays', () => {
  assert.equal(planRoute({ ticket: { category: 'product', request_kind: 'problem' }, destinations: DESTINATIONS }).route, 'stays');
  assert.equal(planRoute({ ticket: { category: 'delivery', request_kind: 'problem' }, destinations: DESTINATIONS }).route, 'stays');
});

test('a lone destination that must match its description is still a choice', () => {
  const on = [dest('Defects', ['product'], { match_description: true })];
  assert.equal(planRoute({ ticket: { category: 'product', request_kind: 'problem' }, destinations: on }).route, 'choose');
});

test('the prompt lists the candidates by id, offers « garder », and shows the domain, never the address', () => {
  const prompt = buildUserPrompt(
    {
      subject: 'UK distribution enquiry',
      messages: [{ body_text: 'Hello from London' }],
      senderDomain: 'example.co.uk',
      senderLabel: 'retailer',
      language: 'en'
    },
    DESTINATIONS.slice(1, 3),
    ['S1', 'S2']
  );
  assert.match(prompt, /- S1 — Accounting : Accounting handles things/);
  assert.match(prompt, /- S2 — Export : /);
  assert.match(prompt, /- garder — /);
  assert.match(prompt, /Domaine de l'expéditeur : example\.co\.uk \(connu de nous : enseigne/);
  assert.doesNotMatch(prompt, /@/);
});

function fakeOpenAI(answer) {
  const calls = [];
  return {
    calls,
    async completeJson(request) {
      calls.push(request);
      return answer;
    }
  };
}

test('the chooser maps the model\'s id back to the destination', async () => {
  const openai = fakeOpenAI({ destination: 'S2', reason: '  foreign   distributor ' });
  const { choose } = createDestinationChooser(openai, { model: 'mini' });
  const result = await choose({ subject: 'x', messages: [] }, DESTINATIONS.slice(1, 3), { ticketId: 't1' });
  assert.equal(result.destination.label, 'Export');
  assert.equal(result.reason, 'foreign distributor');
  assert.deepEqual(openai.calls[0].schema.properties.destination.enum, ['S1', 'S2', 'garder']);
  assert.equal(openai.calls[0].ticketId, 't1');
});

test('« garder », or anything unrecognised, keeps the ticket', async () => {
  for (const answer of [{ destination: 'garder', reason: 'reorder PO' }, { destination: 'S9' }, null]) {
    const { choose } = createDestinationChooser(fakeOpenAI(answer), { model: 'mini' });
    const result = await choose({ messages: [] }, DESTINATIONS.slice(1, 3));
    assert.equal(result.destination, null);
  }
});

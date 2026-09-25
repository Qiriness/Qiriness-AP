import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSenderDirectory } from '../src/ingestion/sender-directory.mjs';

import { cutsFor, threadGroup, threadUpTo } from './casework-cuts.mjs';
import { emptyLabel, validateLabel } from './casework-vocabulary.mjs';

const directory = buildSenderDirectory(
  [{ pattern_type: 'domain', pattern: 'deret.fr', label: 'logistics' }],
  { supportMailbox: 'service@qiriness.com' }
);

const customer = (id) => ({ id, direction: 'inbound', from_email: 'a@gmail.com', received_at: `2026-09-0${id}` });
const ours = (id) => ({ id, direction: 'outbound', from_email: 'service@qiriness.com', received_at: `2026-09-0${id}` });
const deret = (id) => ({ id, direction: 'inbound', from_email: 'x@deret.fr', received_at: `2026-09-0${id}` });

test('a single message is not a thread', () => {
  assert.equal(threadGroup([customer(1)], directory), null);
});

test('two customer messages outrank another sender, so a thread is counted once', () => {
  assert.equal(threadGroup([customer(1), deret(2), customer(3)], directory), 'customer_followup');
});

test('a partner writing on the thread puts it in the set without a customer follow-up', () => {
  assert.equal(threadGroup([customer(1), deret(2)], directory), 'other_sender');
});

test('one customer message and our reply is the opt-in group', () => {
  assert.equal(threadGroup([customer(1), ours(2)], directory), 'replied_once');
});

test('every message after the first is a cut, in both directions, with its sender resolved', () => {
  const cuts = cutsFor([customer(1), ours(2), deret(3), customer(4)], directory);
  assert.deepEqual(
    cuts.map((cut) => [cut.messageId, cut.index, cut.direction, cut.role]),
    [
      [2, 1, 'outbound', 'qiriness'],
      [3, 2, 'inbound', 'logistics'],
      [4, 3, 'inbound', 'customer']
    ]
  );
});

test('the thread at a cut ends at that message', () => {
  const thread = [customer(1), ours(2), customer(3)];
  assert.deepEqual(threadUpTo(thread, 1).map((m) => m.id), [1, 2]);
});

test('a label keeps known values and reports the rest', () => {
  const { label, dropped } = validateLabel(
    {
      ...emptyLabel(),
      effect: 'closes_case',
      answered: ['shopify_order_number', 'delivery_state', 'made_up'],
      waitingInternal: ['photo'],
      nextAction: 'no_reply'
    },
    { direction: 'inbound' }
  );
  assert.equal(label.effect, 'closes_case');
  assert.deepEqual(label.answered, ['shopify_order_number', 'delivery_state']);
  // A customer question is not an internal check, so it cannot be owed by us.
  assert.deepEqual(label.waitingInternal, []);
  assert.deepEqual(dropped, ['answered=made_up', 'waitingInternal=photo']);
});

test('an effect from the other direction is refused', () => {
  const { label, dropped } = validateLabel({ effect: 'holding' }, { direction: 'inbound' });
  assert.equal(label.effect, null);
  assert.deepEqual(dropped, ['effect=holding']);
});

test('the review page carries message text as data, so markup in a body cannot end the script', async () => {
  const { renderReviewPage } = await import('./casework-review-page.mjs');
  const html = renderReviewPage({
    generatedAt: '2026-09-24T00:00:00.000Z',
    threads: [{ ticketId: 't', subject: 's', category: 'c', group: 'customer_followup', cuts: [],
      messages: [{ id: 1, direction: 'inbound', roleName: 'client', at: null, own: '</script><b>x</b>', quoted: '' }] }]
  });
  assert.equal(html.match(/<\/script>/g).length, 2);
  const json = html.match(/<script type="application\/json" id="data">(.*?)<\/script>/s)[1];
  assert.equal(JSON.parse(json).threads[0].messages[0].own, '</script><b>x</b>');
});

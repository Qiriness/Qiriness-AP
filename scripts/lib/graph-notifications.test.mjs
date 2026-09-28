import assert from 'node:assert/strict';
import test from 'node:test';

import { handleGraphNotification } from './graph-notifications.mjs';
import { clientStateMatches, hashClientState } from './mail-subscription-record.mjs';

const SECRET = 'the-client-state';

function fakes() {
  const subscriptionRows = [
    { shop_id: 'shop-1', folder: 'inbox', subscription_id: 'sub-inbox', client_state_hash: hashClientState(SECRET) },
    { shop_id: 'shop-1', folder: 'sentitems', subscription_id: 'sub-sent', client_state_hash: hashClientState(SECRET) }
  ];
  const flagged = [];
  const enqueued = [];
  return {
    flagged,
    enqueued,
    subscriptions: {
      bySubscriptionId: async (id) => subscriptionRows.find((row) => row.subscription_id === id) ?? null,
      flagRenewal: async (id) => flagged.push(id)
    },
    jobsFor: (shopId) => ({ enqueue: async (job) => enqueued.push({ shopId, ...job }) })
  };
}

const body = (value) => JSON.stringify({ value });

test('the subscription handshake echoes the token as plain text', async () => {
  const f = fakes();
  const result = await handleGraphNotification({ validationToken: 'abc 123', ...f });
  assert.equal(result.status, 200);
  assert.equal(result.contentType, 'text/plain');
  assert.equal(result.body, 'abc 123');
  assert.equal(f.enqueued.length, 0);
});

test('a believed notification queues one read of its folder, and reads nothing itself', async () => {
  const f = fakes();
  const result = await handleGraphNotification({
    rawBody: body([
      { subscriptionId: 'sub-inbox', clientState: SECRET, resource: 'x' },
      { subscriptionId: 'sub-inbox', clientState: SECRET, resource: 'y' }
    ]),
    ...f
  });
  assert.equal(result.status, 202);
  assert.deepEqual(f.enqueued, [
    { shopId: 'shop-1', kind: 'sync_mailbox', dedupeKey: 'sync:inbox', payload: { folder: 'inbox' } }
  ]);
  assert.equal(result.summary.accepted, 2);
});

test('a wrong secret or an unknown subscription is dropped with a 202, so Graph does not retry', async () => {
  const f = fakes();
  const result = await handleGraphNotification({
    rawBody: body([
      { subscriptionId: 'sub-inbox', clientState: 'guessed' },
      { subscriptionId: 'sub-inbox' },
      { subscriptionId: 'sub-nobody', clientState: SECRET }
    ]),
    ...f
  });
  assert.equal(result.status, 202);
  assert.equal(result.summary.rejected, 3);
  assert.equal(f.enqueued.length, 0);
});

test('a lifecycle event flags the subscription for renewal and still asks for a read', async () => {
  const f = fakes();
  await handleGraphNotification({
    rawBody: body([
      { subscriptionId: 'sub-sent', clientState: SECRET, lifecycleEvent: 'reauthorizationRequired' },
      { subscriptionId: 'sub-inbox', clientState: SECRET, lifecycleEvent: 'missed' }
    ]),
    ...f
  });
  assert.deepEqual(f.flagged, ['sub-sent']);
  assert.deepEqual(f.enqueued.map((j) => j.dedupeKey).sort(), ['sync:inbox', 'sync:sentitems']);
});

test('a body that is not JSON is accepted and ignored', async () => {
  const f = fakes();
  const result = await handleGraphNotification({ rawBody: 'not json', ...f });
  assert.equal(result.status, 202);
  assert.equal(f.enqueued.length, 0);
});

test('the client state is compared by hash, and never equal to an empty value', () => {
  assert.equal(clientStateMatches(SECRET, hashClientState(SECRET)), true);
  assert.equal(clientStateMatches('other', hashClientState(SECRET)), false);
  assert.equal(clientStateMatches('', hashClientState('')), false);
  assert.equal(clientStateMatches(undefined, hashClientState(SECRET)), false);
  assert.equal(clientStateMatches(SECRET, 'not-hex'), false);
});

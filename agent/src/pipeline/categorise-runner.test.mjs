import assert from 'node:assert/strict';
import test from 'node:test';

import { runCategorisation } from './categorise-runner.mjs';

function fakeStore({ tickets = [], messages = {} } = {}) {
  const updates = [];
  return {
    updates,
    async findUncategorisedTickets() {
      return tickets;
    },
    async findInboundMessages(ticketId) {
      return messages[ticketId] || [];
    },
    async updateTicket(ticketId, patch) {
      updates.push({ ticketId, patch });
    }
  };
}

const verdict = (overrides = {}) => ({
  category: 'delivery',
  request_kind: 'problem',
  secondary_category: null,
  secondary_request_kind: null,
  level: 3,
  responsible_team: 'logistics',
  reason: 'colis non livré',
  model: 'gpt-4o-mini',
  ...overrides
});

const ticket = (overrides = {}) => ({ id: 't1', subject: 'Colis', metadata: {}, ...overrides });

test('writes both axes, the level and the team back to the ticket', async () => {
  const store = fakeStore({
    tickets: [ticket()],
    messages: { t1: [{ body_text: 'Mon colis nest jamais arrivé' }] }
  });
  const counts = await runCategorisation({
    store,
    categorise: async () => verdict(),
    shopId: 'shop'
  });

  assert.deepEqual(counts, { categorised: 1, skipped: 0, failed: 0, fallbacks: 0 });
  const { patch } = store.updates[0];
  assert.equal(patch.category, 'delivery');
  assert.equal(patch.request_kind, 'problem');
  assert.equal(patch.level, 3);
  assert.equal(patch.responsible_team, 'logistics');
  assert.equal(patch.metadata.categorisation.model, 'gpt-4o-mini');
  assert.equal(patch.metadata.categorisation.reason, 'colis non livré');
});

test('passes the ticket subject and its inbound messages to the categoriser', async () => {
  const store = fakeStore({
    tickets: [ticket()],
    messages: { t1: [{ body_text: 'un' }, { body_text: 'deux' }] }
  });
  let seen;
  await runCategorisation({
    store,
    categorise: async (arg) => {
      seen = arg;
      return verdict();
    },
    shopId: 'shop'
  });
  assert.equal(seen.subject, 'Colis');
  assert.equal(seen.messages.length, 2);
});

test('a ticket with no inbound message is skipped, not guessed at', async () => {
  const store = fakeStore({ tickets: [ticket()], messages: {} });
  const counts = await runCategorisation({
    store,
    categorise: async () => assert.fail('should not classify'),
    shopId: 'shop'
  });
  assert.equal(counts.skipped, 1);
  assert.equal(store.updates.length, 0);
});

test('a failure leaves the ticket pending and counts the attempt', async () => {
  const store = fakeStore({ tickets: [ticket()], messages: { t1: [{ body_text: 'x' }] } });
  const counts = await runCategorisation({
    store,
    categorise: async () => {
      throw new Error('rate limited');
    },
    shopId: 'shop',
    logger: { warn() {} }
  });

  assert.equal(counts.failed, 1);
  assert.equal(counts.fallbacks, 0);
  const { patch } = store.updates[0];
  // category stays null, so the next poll re-selects this ticket.
  assert.ok(!('category' in patch));
  assert.equal(patch.metadata.categorisation.attempts, 1);
  assert.equal(patch.metadata.categorisation.last_error, 'rate limited');
});

test('after the last attempt it falls back towards a human instead of retrying forever', async () => {
  const store = fakeStore({
    tickets: [ticket({ metadata: { categorisation: { attempts: 2 } } })],
    messages: { t1: [{ body_text: 'x' }] }
  });
  const counts = await runCategorisation({
    store,
    categorise: async () => {
      throw new Error('still broken');
    },
    shopId: 'shop',
    logger: { warn() {}, error() {} }
  });

  assert.equal(counts.fallbacks, 1);
  const { patch } = store.updates[0];
  assert.equal(patch.category, 'other');
  assert.equal(patch.request_kind, 'problem');
  assert.equal(patch.level, 3); // level 3 -> a human sees it
  assert.equal(patch.responsible_team, 'contact');
  // Recorded as a fallback, so it is never read as a real verdict.
  assert.equal(patch.metadata.categorisation.failed, true);
  assert.equal(patch.metadata.categorisation.attempts, 3);
});

test('metadata written by anything else on the ticket survives', async () => {
  const store = fakeStore({
    tickets: [ticket({ metadata: { source: 'graph', categorisation: { attempts: 1 } } })],
    messages: { t1: [{ body_text: 'x' }] }
  });
  await runCategorisation({ store, categorise: async () => verdict(), shopId: 'shop' });
  const { patch } = store.updates[0];
  assert.equal(patch.metadata.source, 'graph');
  assert.equal(patch.metadata.categorisation.attempts, 2);
});

test('one failing ticket does not stop the batch', async () => {
  const store = fakeStore({
    tickets: [ticket({ id: 't1' }), ticket({ id: 't2' })],
    messages: { t1: [{ body_text: 'x' }], t2: [{ body_text: 'y' }] }
  });
  const counts = await runCategorisation({
    store,
    categorise: async ({ messages }) => {
      if (messages[0].body_text === 'x') throw new Error('boom');
      return verdict();
    },
    shopId: 'shop',
    logger: { warn() {} }
  });
  assert.equal(counts.failed, 1);
  assert.equal(counts.categorised, 1);
});

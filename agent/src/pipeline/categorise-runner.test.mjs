import assert from 'node:assert/strict';
import test from 'node:test';

import { runCategorisation } from './categorise-runner.mjs';

function fakeStore({ tickets = [], messages = {} } = {}) {
  const updates = [];
  return {
    updates,
    async findTicketsNeedingCategorisation() {
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
  confidence: 'high',
  language: 'fr',
  happiness: 2,
  reason: 'colis non livré',
  model: 'gpt-4o-mini',
  ...overrides
});

/** A ticket that has never been categorised — what ingestion has just created. */
const ticket = (overrides = {}) => ({ id: 't1', subject: 'Colis', metadata: {}, ...overrides });

/** A ticket already carrying labels, back in the queue because the customer replied. */
const categorisedTicket = (overrides = {}) => ticket({
  category: 'order',
  request_kind: 'question',
  level: 2,
  happiness: 2,
  metadata: { categorisation: { at: '2026-07-01T09:00:00Z', model: 'gpt-4o-mini', runs: 1 } },
  ...overrides
});

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

  assert.deepEqual(counts, {
    categorised: 1,
    recategorised: 0,
    skipped: 0,
    failed: 0,
    fallbacks: 0
  });
  const { patch } = store.updates[0];
  assert.equal(patch.category, 'delivery');
  assert.equal(patch.request_kind, 'problem');
  assert.equal(patch.level, 3);
  assert.equal(patch.responsible_team, 'logistics');
  assert.equal(patch.metadata.categorisation.model, 'gpt-4o-mini');
  assert.equal(patch.metadata.categorisation.reason, 'colis non livré');
});

test('writes the three signals and takes the ticket out of the pending set', async () => {
  const store = fakeStore({
    tickets: [ticket()],
    messages: { t1: [{ body_text: 'Where is my parcel?' }] }
  });
  await runCategorisation({
    store,
    categorise: async () => verdict({ confidence: 'medium', language: 'en', happiness: 3 }),
    shopId: 'shop'
  });

  const { patch } = store.updates[0];
  assert.equal(patch.categorisation_confidence, 'medium');
  assert.equal(patch.language, 'en');
  assert.equal(patch.happiness, 3);
  assert.equal(patch.needs_categorisation, false);
  assert.ok(patch.categorised_at, 'categorised_at should stamp when the labels were written');
});

test('a reply re-categorises the ticket instead of leaving the first label frozen', async () => {
  // The whole point of the flag: ingestion puts a ticket that already has labels
  // back in the queue, and the new reading replaces the old one.
  const store = fakeStore({
    tickets: [categorisedTicket()],
    messages: {
      t1: [{ body_text: 'Où est ma commande ?' }, { body_text: "Le colis est arrivé cassé" }]
    }
  });
  const counts = await runCategorisation({
    store,
    categorise: async () => verdict(),
    shopId: 'shop',
    logger: { info() {} }
  });

  // Counted apart from a first pass — the two say different things about the mailbox.
  assert.equal(counts.recategorised, 1);
  assert.equal(counts.categorised, 0);
  const { patch } = store.updates[0];
  assert.equal(patch.category, 'delivery'); // was order
  assert.equal(patch.request_kind, 'problem'); // was question
  assert.equal(patch.level, 3); // was 2 — the escalation this feature exists for
});

test('the categoriser is never shown the labels it produced last time', async () => {
  // Blind by design: anchoring the model on its own previous answer makes it
  // defend a first call that may have been wrong.
  const store = fakeStore({
    tickets: [categorisedTicket()],
    messages: { t1: [{ body_text: 'suite' }] }
  });
  let seen;
  await runCategorisation({
    store,
    categorise: async (arg) => {
      seen = arg;
      return verdict();
    },
    shopId: 'shop',
    logger: { info() {} }
  });
  assert.deepEqual(Object.keys(seen).sort(), ['messages', 'subject']);
});

test('a re-categorisation can raise a level but never lower it', async () => {
  const store = fakeStore({
    tickets: [categorisedTicket({ level: 3 })],
    messages: { t1: [{ body_text: 'merci, et du coup le remboursement ?' }] }
  });
  await runCategorisation({
    store,
    // A calmer follow-up reads as a level 1 question on its own...
    categorise: async () => verdict({ category: 'product', request_kind: 'question', level: 1 }),
    shopId: 'shop',
    logger: { info() {} }
  });

  // ... but the refund this ticket earned at 3 is still owed.
  assert.equal(store.updates[0].patch.level, 3);
  // What the model actually said is kept, so the ratchet is visible rather than
  // looking like the model keeps choosing 3.
  assert.equal(store.updates[0].patch.metadata.categorisation.proposed_level, 1);
});

test('superseded labels are kept as a trajectory, newest first and capped', async () => {
  const store = fakeStore({
    tickets: [categorisedTicket({
      metadata: {
        categorisation: {
          at: '2026-07-01T09:00:00Z',
          history: Array.from({ length: 5 }, (_, i) => ({ category: 'other', level: 1, at: `old-${i}` }))
        }
      }
    })],
    messages: { t1: [{ body_text: 'suite' }] }
  });
  await runCategorisation({
    store,
    categorise: async () => verdict(),
    shopId: 'shop',
    logger: { info() {} }
  });

  const { history } = store.updates[0].patch.metadata.categorisation;
  assert.equal(history.length, 5, 'history must not grow without bound');
  assert.deepEqual(history[0], {
    category: 'order',
    request_kind: 'question',
    level: 2,
    happiness: 2,
    at: '2026-07-01T09:00:00Z'
  });
  assert.equal(history[1].at, 'old-0'); // the previous entries shift down
});

test('a first pass writes no history entry — there is nothing it replaced', async () => {
  const store = fakeStore({
    tickets: [ticket()],
    messages: { t1: [{ body_text: 'x' }] }
  });
  await runCategorisation({ store, categorise: async () => verdict(), shopId: 'shop' });
  assert.deepEqual(store.updates[0].patch.metadata.categorisation.history, []);
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
  // No labels written, and the flag is left alone, so the next poll re-selects it.
  assert.ok(!('category' in patch));
  assert.ok(!('needs_categorisation' in patch));
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
  assert.equal(patch.categorisation_confidence, 'low');
  // Flag cleared, or a permanently broken ticket occupies a batch slot forever.
  assert.equal(patch.needs_categorisation, false);
});

test('a failed RE-categorisation keeps the existing labels rather than clobbering them', async () => {
  // The fallback exists to make an unjudged ticket visible. A ticket that already
  // has labels is not unjudged: overwriting a real (delivery, problem, 3) reading
  // with (other, problem) would destroy information to say "we don't know".
  const store = fakeStore({
    tickets: [categorisedTicket({
      category: 'delivery',
      request_kind: 'problem',
      level: 3,
      // Out of retries: this is the last attempt, so the fallback branch runs.
      metadata: { categorisation: { at: '2026-07-01T09:00:00Z', attempts: 2 } }
    })],
    messages: { t1: [{ body_text: 'suite' }] }
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
  assert.ok(!('category' in patch), 'the existing labels must survive');
  assert.ok(!('level' in patch));
  // ... but they are now known to be stale, so they stop counting as confident.
  assert.equal(patch.categorisation_confidence, 'low');
  assert.equal(patch.metadata.categorisation.failed, true);
  assert.equal(patch.needs_categorisation, false);
});

test('metadata written by anything else on the ticket survives', async () => {
  const store = fakeStore({
    tickets: [ticket({ metadata: { source: 'graph', categorisation: { attempts: 1 } } })],
    messages: { t1: [{ body_text: 'x' }] }
  });
  await runCategorisation({ store, categorise: async () => verdict(), shopId: 'shop' });
  const { patch } = store.updates[0];
  assert.equal(patch.metadata.source, 'graph');
});

test('a success clears the failures of the cycle it ends', async () => {
  // attempts counts consecutive failures in the CURRENT pending cycle, so a
  // ticket that stumbled twice must get its full three attempts again next time a
  // reply puts it back in the queue — and a stale error must not sit next to
  // good labels.
  const store = fakeStore({
    tickets: [ticket({ metadata: { categorisation: { attempts: 2, last_error: 'rate limited' } } })],
    messages: { t1: [{ body_text: 'x' }] }
  });
  await runCategorisation({ store, categorise: async () => verdict(), shopId: 'shop' });
  const { categorisation } = store.updates[0].patch.metadata;
  assert.equal(categorisation.attempts, 0);
  assert.equal(categorisation.last_error, null);
  assert.equal(categorisation.runs, 1);
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

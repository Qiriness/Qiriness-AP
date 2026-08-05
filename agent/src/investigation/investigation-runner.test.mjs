import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCaseFile } from './case-file.mjs';
import { runInvestigation } from './investigation-runner.mjs';

const TICKET = {
  id: 'tk1',
  subject: 'Masque LED',
  category: 'product',
  request_kind: 'question',
  level: 1,
  customer_id: 'c1',
  metadata: {},
  resolved_context: {}
};

const MESSAGES = [
  { id: 'm1', body_text: 'le masque LED convient-il ?', received_at: '2026-08-01T09:00:00Z' },
  { id: 'm2', body_text: 'des nouvelles ?', received_at: '2026-08-03T09:00:00Z' }
];

function caseFile(overrides = {}) {
  return buildCaseFile({
    answer: {
      verdict: 'answerable',
      established: [{ claim: 'Le masque convient aux peaux sensibles.', evidence_ids: ['t1'] }],
      unverified: [],
      missing: [],
      handoff: null,
      ...overrides
    },
    ledger: [{ id: 't1', tool: 'lookupProduct', argsHash: '', outcome: 'found' }],
    proposedLevel: overrides.proposedLevel ?? 1,
    model: 'm'
  });
}

function buildStore({ tickets = [TICKET], messages = MESSAGES } = {}) {
  const saved = [];
  const updates = [];
  return {
    saved,
    updates,
    async findTicketsNeedingInvestigation() {
      return tickets;
    },
    async findInboundMessages() {
      return messages;
    },
    async saveInvestigation(payload) {
      saved.push(payload);
    },
    async updateTicket(ticketId, patch) {
      updates.push({ ticketId, patch });
    }
  };
}

test('an investigable ticket is investigated and its case file stored', async () => {
  const store = buildStore();
  const counts = await runInvestigation({
    store,
    investigate: async () => caseFile(),
    shopId: 's1'
  });

  assert.equal(counts.answerable, 1);
  assert.equal(store.saved.length, 1);
  assert.equal(store.saved[0].caseFile.verdict, 'answerable');
});

test('the investigation is keyed on the latest inbound message', async () => {
  // One case file per message that triggered it — the idempotency key, and the
  // reason a thread that escalated keeps both readings.
  const store = buildStore();
  await runInvestigation({ store, investigate: async () => caseFile(), shopId: 's1' });
  assert.equal(store.saved[0].triggerMessageId, 'm2');
});

test('the agent is given the first and the latest inbound message', async () => {
  let seen;
  const store = buildStore();
  await runInvestigation({
    store,
    investigate: async (input) => {
      seen = input;
      return caseFile();
    },
    shopId: 's1'
  });

  assert.match(seen.text, /masque LED convient/);
  assert.match(seen.text, /des nouvelles/);
  assert.equal(seen.category, 'product');
});

test('an out-of-scope subject is skipped and its flag cleared', async () => {
  // delivery has a full tool policy and no synced order data behind it. Leaving
  // the flag set would park it at the front of an oldest-first batch for good.
  const store = buildStore({ tickets: [{ ...TICKET, category: 'delivery', request_kind: 'problem', level: 2 }] });
  const counts = await runInvestigation({ store, investigate: async () => caseFile(), shopId: 's1' });

  assert.equal(counts.skipped, 1);
  assert.equal(store.saved.length, 0);
  assert.deepEqual(store.updates[0].patch, { needs_investigation: false });
});

test('a thread holding no customer message is skipped, not guessed at', async () => {
  const store = buildStore({ messages: [] });
  const counts = await runInvestigation({ store, investigate: async () => caseFile(), shopId: 's1' });

  assert.equal(counts.skipped, 1);
  assert.deepEqual(store.updates[0].patch, { needs_investigation: false });
});

test('an escalation raises the level, and nothing lowers it', async () => {
  const store = buildStore({ tickets: [{ ...TICKET, level: 2 }] });
  await runInvestigation({
    store,
    investigate: async () => caseFile({ proposedLevel: 3 }),
    shopId: 's1'
  });
  assert.equal(store.saved[0].level, 3);

  const lower = buildStore({ tickets: [{ ...TICKET, level: 3 }] });
  await runInvestigation({
    store: lower,
    investigate: async () => caseFile({ proposedLevel: 1 }),
    shopId: 's1'
  });
  assert.equal(lower.saved[0].level, 3, 'the ratchet holds');
});

test('a failure is retried before anything is written', async () => {
  const store = buildStore();
  const counts = await runInvestigation({
    store,
    investigate: async () => {
      throw new Error('openai down');
    },
    shopId: 's1'
  });

  assert.equal(counts.failed, 1);
  assert.equal(store.saved.length, 0);
  assert.equal(store.updates[0].patch.metadata.investigation.attempts, 1);
  assert.equal(
    store.updates[0].patch.needs_investigation,
    undefined,
    'the flag stays raised so the next poll retries'
  );
});

test('after three attempts the ticket is released towards a human', async () => {
  const store = buildStore({
    tickets: [{ ...TICKET, metadata: { investigation: { attempts: 2 } } }]
  });
  await runInvestigation({
    store,
    investigate: async () => {
      throw new Error('openai down');
    },
    shopId: 's1'
  });

  const patch = store.updates[0].patch;
  assert.equal(patch.needs_investigation, false, 'it must not occupy a batch slot forever');
  assert.equal(patch.metadata.investigation.failed, true);
  assert.equal(patch.metadata.investigation.verdict, 'needs_human');
});

test('a dry run investigates but writes nothing', async () => {
  const store = buildStore();
  const counts = await runInvestigation({
    store,
    investigate: async () => caseFile(),
    shopId: 's1',
    dryRun: true
  });

  assert.equal(counts.answerable, 1);
  assert.equal(store.saved.length, 0);
  assert.equal(store.updates.length, 0);
});

test('each verdict is counted under its own name', async () => {
  const store = buildStore({
    tickets: [TICKET, { ...TICKET, id: 'tk2' }, { ...TICKET, id: 'tk3' }]
  });
  const verdicts = ['answerable', 'needs_customer_input', 'needs_human'];
  let index = 0;

  const counts = await runInvestigation({
    store,
    investigate: async () => {
      const verdict = verdicts[index++];
      return caseFile({
        verdict,
        missing: verdict === 'needs_customer_input' ? [{ field: 'product_name' }] : []
      });
    },
    shopId: 's1'
  });

  assert.equal(counts.answerable, 1);
  assert.equal(counts.needs_customer_input, 1);
  assert.equal(counts.needs_human, 1);
  assert.equal(counts.considered, 3);
});

test('the log line carries no claim text', async () => {
  const logged = [];
  const store = buildStore();
  await runInvestigation({
    store,
    investigate: async () => caseFile(),
    shopId: 's1',
    logger: { info: (event, fields) => logged.push({ event, fields }) }
  });

  const serialised = JSON.stringify(logged);
  assert.ok(!serialised.includes('peaux sensibles'));
  assert.equal(logged[0].fields.established, 1);
});

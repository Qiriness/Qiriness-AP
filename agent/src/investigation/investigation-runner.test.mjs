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
  // `cosmetovigilance` is left to a person by policy: its tool set is empty, so
  // `isInvestigable` refuses it. Leaving the flag set would park it at the front
  // of an oldest-first batch for good.
  const store = buildStore({ tickets: [{ ...TICKET, category: 'cosmetovigilance', request_kind: 'problem', level: 2 }] });
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

// --- exemplar matching, which rides along and must never steer ----------------

const EXEMPLAR_RESULT = {
  matched: true,
  verdict: 'matched',
  exemplar: { exemplarKey: 'PR-24', requirementNeeds: ['product_property'] },
  bestSimilarity: 0.8244,
  margin: 0.1312,
  candidates: [{ exemplarKey: 'PR-24' }, { exemplarKey: 'PR-27' }]
};

test('the matched situation is stored beside the case file', async () => {
  const store = buildStore();
  await runInvestigation({
    store,
    investigate: async () => caseFile(),
    shopId: 's1',
    retrieveExemplar: async () => EXEMPLAR_RESULT
  });

  assert.deepEqual(store.saved[0].exemplarMatch, {
    verdict: 'matched',
    exemplar_key: 'PR-24',
    closest: 'PR-24',
    // Rounded to three places: the fourth is noise at the precision cosine
    // similarity actually carries.
    similarity: 0.824,
    margin: 0.131,
    runner_up: 'PR-27',
    requirement_needs: ['product_property']
  });
});

test('it is matched on the message that triggered the run, and reuses its vector', async () => {
  // The bands were calibrated on each ticket's FIRST message; the run is
  // triggered by the LATEST. Which one is matched has to be unambiguous.
  const seen = [];
  const store = buildStore({
    messages: [
      { id: 'm1', body_text: 'first', received_at: '2026-08-01T09:00:00Z', embedding: '[0.1]' },
      { id: 'm2', body_text: 'latest', received_at: '2026-08-03T09:00:00Z', embedding: '[0.2]' }
    ]
  });

  await runInvestigation({
    store,
    investigate: async () => caseFile(),
    shopId: 's1',
    retrieveExemplar: async (query) => {
      seen.push(query);
      return EXEMPLAR_RESULT;
    }
  });

  assert.equal(seen[0].body, 'latest');
  assert.equal(seen[0].embedding, '[0.2]', 'the stored vector is reused rather than re-embedded');
  assert.equal(store.saved[0].triggerMessageId, 'm2');
});

test('the investigation never sees the exemplar', async () => {
  // Reported-not-enforced is the whole claim: the exemplar's declared needs are
  // only worth comparing against the run's own evidence gaps while the two are
  // reached independently.
  let investigateInput = null;
  await runInvestigation({
    store: buildStore(),
    investigate: async (input) => {
      investigateInput = input;
      return caseFile();
    },
    shopId: 's1',
    retrieveExemplar: async () => EXEMPLAR_RESULT
  });

  assert.ok(!JSON.stringify(investigateInput).includes('PR-24'));
});

test('a failing exemplar lookup costs the case file nothing', async () => {
  const warned = [];
  const store = buildStore();
  const counts = await runInvestigation({
    store,
    investigate: async () => caseFile(),
    shopId: 's1',
    logger: { info: () => {}, warn: (event, fields) => warned.push({ event, fields }) },
    retrieveExemplar: async () => {
      throw new Error('rpc unavailable');
    }
  });

  assert.equal(counts.answerable, 1, 'the investigation still succeeded');
  assert.deepEqual(store.saved[0].exemplarMatch, {});
  assert.equal(warned[0].event, 'investigate.exemplar_failed');
});

test('a caller that has not wired exemplar matching behaves exactly as before', async () => {
  const store = buildStore();
  const counts = await runInvestigation({
    store,
    investigate: async () => caseFile(),
    shopId: 's1'
  });

  assert.equal(counts.answerable, 1);
  assert.deepEqual(store.saved[0].exemplarMatch, {});
});

test('the log names the situation but never a phrasing', async () => {
  const logged = [];
  await runInvestigation({
    store: buildStore(),
    investigate: async () => caseFile(),
    shopId: 's1',
    logger: { info: (event, fields) => logged.push({ event, fields }) },
    retrieveExemplar: async () => ({
      ...EXEMPLAR_RESULT,
      exemplar: { ...EXEMPLAR_RESULT.exemplar, matchedPhrasing: 'je suis inscrite à newsletter' }
    })
  });

  assert.equal(logged[0].fields.exemplarKey, 'PR-24');
  assert.equal(logged[0].fields.exemplarVerdict, 'matched');
  assert.ok(!JSON.stringify(logged).includes('newsletter'));
});

test('a near miss still records which situation nearly won', async () => {
  // The committed key is null below the band, and the closest one is exactly
  // the diagnostic worth keeping: the corpus almost covers this ticket.
  const store = buildStore();
  await runInvestigation({
    store,
    investigate: async () => caseFile(),
    shopId: 's1',
    retrieveExemplar: async () => ({
      matched: false,
      verdict: 'near',
      exemplar: null,
      bestSimilarity: 0.636,
      margin: 0.112,
      candidates: [{ exemplarKey: 'PR-28' }, { exemplarKey: 'PR-24' }]
    })
  });

  const stored = store.saved[0].exemplarMatch;
  assert.equal(stored.verdict, 'near');
  assert.equal(stored.exemplar_key, null, 'nothing was committed');
  assert.equal(stored.closest, 'PR-28', 'but what it nearly was is kept');
  assert.equal(stored.requirement_needs.length, 0);
});

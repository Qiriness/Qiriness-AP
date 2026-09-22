import assert from 'node:assert/strict';
import test from 'node:test';

import { createTicketRecord } from '../../../scripts/lib/ticket-record.mjs';

import { buildSenderDirectory } from '../ingestion/sender-directory.mjs';

import { TICKET_STATUS_BY_VERDICT, buildCaseFile } from './case-file.mjs';
import { createCaseFileStore, runInvestigation } from './investigation-runner.mjs';

const TICKET = {
  id: 'tk1',
  subject: 'Masque LED',
  // What `claim` returns by default: the pass only ever sees open tickets unless
  // an operator widened it. The runner reads this column to decide whether the
  // verdict may move the ticket at all.
  status: 'open',
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

/**
 * The case-file store and the ticket record, as one fake.
 *
 * They are two objects in the real wiring — `ticket_investigations` and
 * `tickets` have different owners now — but a test wants one place to look, so
 * this satisfies both interfaces. `saved` is what reached the case-file table;
 * `updates` is every patch the ticket record built, and it is the REAL record
 * building them, over a fake transport.
 */
function buildStore({ tickets = [TICKET], messages = MESSAGES } = {}) {
  const saved = [];
  const updates = [];
  const record = createTicketRecord({}, {
    shopId: 's1',
    transport: {
      async select(_client, table) {
        return table === 'tickets' ? tickets : messages;
      },
      async selectAll() {
        return [];
      },
      async insert(_client, _table, rows) {
        return rows;
      },
      async update() {
        return [];
      },
      async updateById(_client, _table, ticketId, patch) {
        updates.push({ ticketId, patch });
        return { id: ticketId };
      }
    }
  });

  return Object.assign(record, {
    saved,
    updates,
    async saveCaseFile(payload) {
      saved.push(payload);
    }
  });
}

/** The two roles the fake plays, spread into a runInvestigation call. */
const wire = (fake = buildStore()) => ({ store: fake, record: fake });

test('an investigable ticket is investigated and its case file stored', async () => {
  const store = buildStore();
  const counts = await runInvestigation({
    ...wire(store),
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
  await runInvestigation({ ...wire(store), investigate: async () => caseFile(), shopId: 's1' });
  assert.equal(store.saved[0].triggerMessageId, 'm2');
});

test('the agent is given the first and the latest inbound message', async () => {
  let seen;
  const store = buildStore();
  await runInvestigation({
    ...wire(store),
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

test('a single-message ticket reads exactly as it did before the thread was loaded', async () => {
  // THE SAFETY PROPERTY FOR THE OTHER 79%. 133 of 172 tickets have one inbound
  // message and no reply; rendering them as a labelled transcript would change
  // every one of their prompts to fix the 39 this work is for. Bare body, no
  // label, no date — byte for byte what the two-body assembly produced.
  let seen;
  const store = buildStore({
    messages: [{ id: 'm1', direction: 'inbound', body_text: 'le masque LED convient-il ?', received_at: '2026-08-01T09:00:00Z' }]
  });
  await runInvestigation({
    ...wire(store),
    investigate: async (input) => {
      seen = input;
      return caseFile();
    },
    shopId: 's1'
  });

  assert.equal(seen.text, 'le masque LED convient-il ?');
  assert.deepEqual(seen.threadShape, { inboundCount: 1, outboundCount: 0, lastDirection: 'inbound' });
});

test('our own replies reach the model, labelled and in order', async () => {
  // The whole point. The pass read inbound mail only until 2026-09-21, so « oui,
  // j'ai vérifié » arrived with no record of what had been asked.
  let seen;
  const store = buildStore({
    messages: [
      { id: 'm1', direction: 'inbound', body_text: 'colis non reçu', received_at: '2026-08-01T09:00:00Z' },
      { id: 'm2', direction: 'outbound', body_text: 'avez-vous vu vos voisins ?', received_at: '2026-08-02T09:00:00Z' },
      { id: 'm3', direction: 'inbound', body_text: 'oui, rien chez eux', received_at: '2026-08-03T09:00:00Z' }
    ]
  });
  await runInvestigation({
    ...wire(store),
    investigate: async (input) => {
      seen = input;
      return caseFile();
    },
    shopId: 's1'
  });

  assert.equal(
    seen.text,
    '[client — 2026-08-01]\ncolis non reçu\n\n' +
      '[Qiriness — 2026-08-02]\navez-vous vu vos voisins ?\n\n' +
      '[client — 2026-08-03]\noui, rien chez eux'
  );
  // The case file is still keyed to the customer's latest word, never ours.
  assert.equal(store.saved[0].triggerMessageId, 'm3');
  assert.deepEqual(seen.threadShape, { inboundCount: 2, outboundCount: 1, lastDirection: 'inbound' });
});

test('an unlabelled row stays in the inbound set rather than vanishing', async () => {
  // How the direction filter fails matters: a projection that lost the column
  // degrades to the old behaviour, it does not empty the thread and skip a
  // customer's mail.
  const store = buildStore({
    messages: [{ id: 'm1', body_text: 'le masque LED convient-il ?', received_at: '2026-08-01T09:00:00Z' }]
  });
  const counts = await runInvestigation({ ...wire(store), investigate: async () => caseFile(), shopId: 's1' });

  assert.equal(counts.skipped, 0);
  assert.equal(store.saved.length, 1);
});

async function renderedText(messages) {
  let seen;
  const store = buildStore({ messages });
  await runInvestigation({
    ...wire(store),
    investigate: async (input) => {
      seen = input;
      return caseFile();
    },
    shopId: 's1'
  });
  return seen.text;
}

test('the budget is spent newest first, so the oldest message gives way', async () => {
  // An ascending render that ran out of budget would truncate the message the
  // pass was woken up for, which is the one part of a thread that can never go.
  const text = await renderedText([
    { id: 'm1', direction: 'inbound', body_text: `ancien ${'a'.repeat(7000)}`, received_at: '2026-08-01T09:00:00Z' },
    { id: 'm2', direction: 'outbound', body_text: `réponse ${'b'.repeat(7000)}`, received_at: '2026-08-02T09:00:00Z' },
    { id: 'm3', direction: 'inbound', body_text: 'toujours rien', received_at: '2026-08-03T09:00:00Z' }
  ]);

  assert.match(text, /toujours rien$/);
  // The newest reply survives whole; the opening message is the one cut.
  assert.ok(text.includes('… (message tronqué)'));
  assert.ok(text.indexOf('… (message tronqué)') < text.indexOf('[Qiriness'));
  assert.ok(text.length <= 12000);
});

test('a message that cannot fit its own header is dropped, and counted', async () => {
  // A label with nothing under it says less than an honest count of what the
  // model cannot see.
  const text = await renderedText([
    { id: 'm1', direction: 'inbound', body_text: 'la toute première demande', received_at: '2026-08-01T09:00:00Z' },
    { id: 'm2', direction: 'outbound', body_text: 'a'.repeat(6000), received_at: '2026-08-02T09:00:00Z' },
    { id: 'm3', direction: 'inbound', body_text: 'b'.repeat(6000), received_at: '2026-08-03T09:00:00Z' }
  ]);

  assert.match(text, /^\[… 1 message\(s\) plus ancien\(s\) non inclus\]/);
  assert.ok(!text.includes('la toute première demande'));
  assert.ok(text.length <= 12000);
});

test('an out-of-scope subject is skipped and its flag cleared', async () => {
  // `legal_privacy` is left to a person by policy: its tool set is empty, so
  // `isInvestigable` refuses it. Leaving the flag set would park it at the front
  // of an oldest-first batch for good.
  const store = buildStore({ tickets: [{ ...TICKET, category: 'legal_privacy', request_kind: 'problem', level: 2 }] });
  const counts = await runInvestigation({ ...wire(store), investigate: async () => caseFile(), shopId: 's1' });

  assert.equal(counts.skipped, 1);
  assert.equal(store.saved.length, 0);
  assert.deepEqual(store.updates[0].patch, { needs_investigation: false });
});

test('WHO sent it does not gate the investigation: a colleague thread is investigated', async () => {
  // A skip on non-demand senders lived here briefly and was removed: all 14
  // threads it would have skipped were customer work (L3 returns, team
  // logistics). Skipping them meant no case file for a real customer return
  // because a colleague was the one typing.
  const store = buildStore({
    messages: [{ id: 'm1', body_text: 'la cliente relance sur la commande 6612', from_email: 'tom@lap-groupe.com' }]
  });
  const counts = await runInvestigation({
    ...wire(store),
    investigate: async () => caseFile(),
    shopId: 's1',
    senderDirectory: buildSenderDirectory([
      { pattern_type: 'domain', pattern: 'lap-groupe.com', label: 'internal', note: 'Colleagues.' }
    ])
  });

  assert.equal(counts.skipped, 0);
  assert.equal(store.saved.length, 1, 'the case file is built like any other');
});

test('a retailer thread is skipped whatever its subject, subdomains included', async () => {
  // Nocibé's « Relance commandes en retard » was filed `delivery` and drafted a
  // request for a #XXXX number; its accounting robot writes from sap.nocibe.fr.
  const directory = buildSenderDirectory([
    { pattern_type: 'domain', pattern: 'nocibe.fr', label: 'retailer', note: 'Retail partner.' }
  ]);
  for (const from of ['blanche.thibault@nocibe.fr', 'comptabilite@sap.nocibe.fr']) {
    const store = buildStore({
      tickets: [{ ...TICKET, category: 'delivery', request_kind: 'problem', level: 2 }],
      messages: [{ id: 'm1', body_text: 'Commande n°3089694 en retard', from_email: from }]
    });
    let investigated = false;
    const counts = await runInvestigation({
      ...wire(store),
      investigate: async () => {
        investigated = true;
        return caseFile();
      },
      shopId: 's1',
      senderDirectory: directory
    });
    assert.equal(counts.skipped, 1, from);
    assert.equal(investigated, false, from);
    assert.deepEqual(store.updates[0].patch, { needs_investigation: false }, 'the flag is cleared, as for any skip');
  }
});

test('the retailer skip reads the opening message, not a later reply', async () => {
  // A consumer thread a retailer was copied into later stays a consumer thread.
  const store = buildStore({
    tickets: [{ ...TICKET, category: 'delivery', request_kind: 'problem', level: 2 }],
    messages: [
      { id: 'm1', body_text: 'où est mon colis ?', from_email: 'marie@gmail.com' },
      { id: 'm2', body_text: 'transféré', from_email: 'service@nocibe.fr' }
    ]
  });
  const counts = await runInvestigation({
    ...wire(store),
    investigate: async () => caseFile(),
    shopId: 's1',
    senderDirectory: buildSenderDirectory([
      { pattern_type: 'domain', pattern: 'nocibe.fr', label: 'retailer', note: null }
    ])
  });
  assert.equal(counts.skipped, 0);
  assert.equal(store.saved.length, 1);
});

test('the sender reaches the model as context, so a colleague is not read as the customer', async () => {
  let seen;
  const store = buildStore({
    messages: [{ id: 'm1', body_text: 'la cliente relance', from_email: 'tom@lap-groupe.com' }]
  });
  await runInvestigation({
    ...wire(store),
    investigate: async (input) => {
      seen = input;
      return caseFile();
    },
    shopId: 's1',
    senderDirectory: buildSenderDirectory([
      { pattern_type: 'domain', pattern: 'lap-groupe.com', label: 'internal', note: 'Colleagues.' }
    ])
  });

  assert.equal(seen.sender?.label, 'internal');
  assert.equal(seen.sender?.note, 'Colleagues.');
});

test('a thread holding no customer message is skipped, not guessed at', async () => {
  const store = buildStore({ messages: [] });
  const counts = await runInvestigation({ ...wire(store), investigate: async () => caseFile(), shopId: 's1' });

  assert.equal(counts.skipped, 1);
  assert.deepEqual(store.updates[0].patch, { needs_investigation: false });
});

test('an escalation raises the level, and nothing lowers it', async () => {
  const store = buildStore({ tickets: [{ ...TICKET, level: 2 }] });
  await runInvestigation({
    ...wire(store),
    investigate: async () => caseFile({ proposedLevel: 3 }),
    shopId: 's1'
  });
  assert.equal(store.updates[0].patch.level, 3);

  const lower = buildStore({ tickets: [{ ...TICKET, level: 3 }] });
  await runInvestigation({
    ...wire(lower),
    investigate: async () => caseFile({ proposedLevel: 1 }),
    shopId: 's1'
  });
  assert.equal(lower.updates[0].patch.level, 3, 'the ratchet holds');
});

test('a failure is retried before anything is written', async () => {
  const store = buildStore();
  const counts = await runInvestigation({
    ...wire(store),
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
    ...wire(store),
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
    ...wire(store),
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
    ...wire(store),
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
    ...wire(store),
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
    ...wire(store),
    investigate: async () => caseFile(),
    shopId: 's1',
    retrieveExemplar: async () => EXEMPLAR_RESULT
  });

  assert.deepEqual(store.saved[0].exemplarMatch, {
    verdict: 'matched',
    exemplar_key: 'PR-24',
    closest: 'PR-24',
    // Null here because the fixture's candidates carry no question.
    closest_question: null,
    // Rounded to three places: the fourth is noise at the precision cosine
    // similarity actually carries.
    similarity: 0.824,
    margin: 0.131,
    runner_up: 'PR-27',
    requirement_needs: ['product_property']
  });
});

const NEAR_RESULT = {
  matched: false,
  verdict: 'near',
  exemplar: null,
  bestSimilarity: 0.6304,
  margin: 0.0351,
  candidates: [
    { exemplarKey: 'D-36', question: 'Ma commande a beaucoup de retard', requirementNeeds: ['order_identity'] },
    { exemplarKey: 'D-07', question: 'Quels sont vos délais ?', requirementNeeds: ['policy_answer'] }
  ]
};

const OPENING = [
  { id: 'm1', subject: 'Livraison', body_text: 'Sera-t-elle livrée samedi ?', from_email: 'client@example.fr', received_at: '2026-08-01T09:00:00Z' }
];

test('a near miss is settled by the chooser, and drives the needs and the stored key', async () => {
  const store = buildStore({ messages: OPENING });
  const asked = [];
  await runInvestigation({
    ...wire(store),
    investigate: async () => caseFile(),
    shopId: 's1',
    retrieveExemplar: async () => NEAR_RESULT,
    chooseSituation: async (input) => {
      asked.push(input);
      return { choice: 'D-07', reason: 'Délai de livraison.', model: 'gpt-4o-mini', candidates: ['D-36', 'D-07'] };
    }
  });

  // Asked on the opening message, with the matcher's own candidates.
  assert.equal(asked[0].body, 'Sera-t-elle livrée samedi ?');
  assert.deepEqual(asked[0].candidates.map((c) => c.exemplarKey), ['D-36', 'D-07']);

  const match = store.saved[0].exemplarMatch;
  assert.equal(match.exemplar_key, 'D-07', 'the runner-up the model chose, not the top score');
  assert.equal(match.verdict, 'near', 'the embedding verdict is kept as the record of what it could tell');
  assert.equal(match.chosen_by, 'model');
  assert.deepEqual(match.requirement_needs, ['policy_answer']);
  assert.deepEqual(match.chooser, {
    model: 'gpt-4o-mini',
    choice: 'D-07',
    reason: 'Délai de livraison.',
    candidates: ['D-36', 'D-07']
  });
});

test('the chosen situation is what the rules are selected against', async () => {
  const store = buildStore({ messages: OPENING });
  const seen = [];
  await runInvestigation({
    ...wire(store),
    investigate: async (input) => {
      seen.push(input);
      return caseFile();
    },
    shopId: 's1',
    retrieveExemplar: async () => NEAR_RESULT,
    chooseSituation: async () => ({ choice: 'D-07', reason: 'x', model: 'm', candidates: ['D-36', 'D-07'] }),
    loadAnswers: async () => [
      { answer_key: 'd07_delais', situation_key: 'D-07', when_conditions: {}, answer_skeleton: 's', route: null, ask: [], priority: 0, is_fallback: false }
    ]
  });

  assert.equal(JSON.stringify(seen[0]).includes('D-07'), true, 'the investigation was handed the chosen situation');
});

test('none keeps the near miss unmatched, and says the model was asked', async () => {
  const store = buildStore({ messages: OPENING });
  await runInvestigation({
    ...wire(store),
    investigate: async () => caseFile(),
    shopId: 's1',
    retrieveExemplar: async () => NEAR_RESULT,
    chooseSituation: async () => ({ choice: null, reason: 'Aucune ne correspond.', model: 'm', candidates: ['D-36', 'D-07'] })
  });

  const match = store.saved[0].exemplarMatch;
  assert.equal(match.exemplar_key, null);
  assert.equal(match.chosen_by, undefined);
  assert.equal(match.chooser.choice, 'none');
});

test('our own side is never sent to the chooser', async () => {
  const store = buildStore({ messages: [{ ...OPENING[0], from_email: 'dounia@qiriness.com' }] });
  let called = false;
  await runInvestigation({
    ...wire(store),
    investigate: async () => caseFile(),
    shopId: 's1',
    retrieveExemplar: async () => NEAR_RESULT,
    senderDirectory: { lookup: (email) => (email.endsWith('@qiriness.com') ? { label: 'internal' } : null) },
    chooseSituation: async () => {
      called = true;
      return { choice: 'D-07', reason: 'x', model: 'm', candidates: [] };
    }
  });

  assert.equal(called, false);
  assert.equal(store.saved[0].exemplarMatch.exemplar_key, null);
  assert.deepEqual(store.saved[0].exemplarMatch.chooser, { skipped: 'own_side' });
});

test('a failed chooser call leaves no situation and still investigates', async () => {
  const store = buildStore({ messages: OPENING });
  const counts = await runInvestigation({
    ...wire(store),
    investigate: async () => caseFile(),
    shopId: 's1',
    logger: { info() {}, warn() {} },
    retrieveExemplar: async () => NEAR_RESULT,
    chooseSituation: async () => {
      throw new Error('429');
    }
  });

  assert.equal(counts.answerable, 1);
  assert.equal(store.saved[0].exemplarMatch.exemplar_key, null);
  assert.deepEqual(store.saved[0].exemplarMatch.chooser, { failed: true });
});

test('a confident match never reaches the chooser', async () => {
  const store = buildStore();
  let called = false;
  await runInvestigation({
    ...wire(store),
    investigate: async () => caseFile(),
    shopId: 's1',
    retrieveExemplar: async () => EXEMPLAR_RESULT,
    chooseSituation: async () => {
      called = true;
      return { choice: null, reason: null, model: 'm', candidates: [] };
    }
  });

  assert.equal(called, false);
  assert.equal(store.saved[0].exemplarMatch.exemplar_key, 'PR-24');
  assert.equal(store.saved[0].exemplarMatch.chooser, undefined);
});

test('the situation match is handed to onResult, for callers with no row to read', async () => {
  // The test chat's store is in memory and discarded, so `onResult` is the only
  // way its transcript can say which situation was matched.
  const store = buildStore();
  const results = [];
  await runInvestigation({
    ...wire(store),
    investigate: async () => caseFile(),
    shopId: 's1',
    retrieveExemplar: async () => ({
      ...EXEMPLAR_RESULT,
      candidates: [{ exemplarKey: 'PR-24', question: 'Ce produit convient-il ?' }, { exemplarKey: 'PR-27' }]
    }),
    onResult: (result) => results.push(result)
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].exemplarMatch.exemplar_key, 'PR-24');
  assert.equal(results[0].exemplarMatch.closest_question, 'Ce produit convient-il ?');
});

test('it is matched on the opening message, and reuses that message vector', async () => {
  // REVERSED 2026-09-03. This test used to assert `latest`, and its own comment
  // named the reason it was wrong: "the bands were calibrated on each ticket's
  // FIRST message; the run is triggered by the LATEST". The mismatch was known
  // and settled the other way — unambiguously matching the trigger — which
  // applied a 0.65 threshold to a distribution it had never been measured on.
  //
  // What changed is a measurement rather than an opinion. On the nine
  // multi-message threads in the 2026-09-03 sample the opening message scored
  // higher on six and doubled the matches; the ticket that exposed it opens
  // « ma commande #6686 n'est toujours pas traitée » and closes « j'ai bien reçu
  // ma commande », scoring 0.623 against an address-change situation on the last
  // message and 0.869 against O-09 on the first.
  //
  // The vector reuse is the half that did not change: whichever message is
  // matched, its stored embedding is used rather than paying to embed again.
  const seen = [];
  const store = buildStore({
    messages: [
      { id: 'm1', body_text: 'first', received_at: '2026-08-01T09:00:00Z', embedding: '[0.1]' },
      { id: 'm2', body_text: 'latest', received_at: '2026-08-03T09:00:00Z', embedding: '[0.2]' }
    ]
  });

  await runInvestigation({
    ...wire(store),
    investigate: async () => caseFile(),
    shopId: 's1',
    retrieveExemplar: async (query) => {
      seen.push(query);
      return EXEMPLAR_RESULT;
    }
  });

  assert.equal(seen[0].body, 'first');
  assert.equal(seen[0].embedding, '[0.1]', 'the stored vector is reused rather than re-embedded');
  // The case file is still keyed to the TRIGGER, which is the newest message.
  // Changing what the matcher reads must not move where the row lands.
  assert.equal(store.saved[0].triggerMessageId, 'm2');
});

test('the investigation never sees the exemplar', async () => {
  // Reported-not-enforced is the whole claim: the exemplar's declared needs are
  // only worth comparing against the run's own evidence gaps while the two are
  // reached independently.
  let investigateInput = null;
  await runInvestigation({
    ...wire(),
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
    ...wire(store),
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
    ...wire(store),
    investigate: async () => caseFile(),
    shopId: 's1'
  });

  assert.equal(counts.answerable, 1);
  assert.deepEqual(store.saved[0].exemplarMatch, {});
});

test('the log names the situation but never a phrasing', async () => {
  const logged = [];
  await runInvestigation({
    ...wire(),
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
    ...wire(store),
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

// --- where the verdict leaves the ticket in the queue -------------------------

test('needs_customer_input parks the ticket awaiting the customer', async () => {
  const store = buildStore();
  await runInvestigation({
    ...wire(store),
    investigate: async () =>
      caseFile({ verdict: 'needs_customer_input', missing: [{ field: 'shopify_order_number' }] }),
    shopId: 's1'
  });

  assert.equal(store.saved[0].caseFile.verdict, 'needs_customer_input');
  assert.equal(
    TICKET_STATUS_BY_VERDICT[store.saved[0].caseFile.verdict],
    'awaiting_customer',
    'and that verdict is what parks it'
  );

  // The table above says what the verdict MEANS; this says the runner acts on it.
  // Only the second one breaks if the status write is lost, which is exactly what
  // happened when the write became conditional on the ticket being open.
  const patch = store.updates.find((u) => u.patch?.status);
  assert.equal(patch?.patch.status, 'awaiting_customer', 'and the ticket is actually moved');
});

// --- a deliberate re-run over threads the queue has moved past ----------------

test('a closed ticket gets a case file and keeps its status', async () => {
  // `--include-closed` is a backfill over a historical corpus. 65% of verdicts map
  // to awaiting_human / awaiting_customer, so letting the verdict move these would
  // resurrect settled threads into the live queue by the dozen.
  const closed = { ...TICKET, status: 'closed' };
  const store = buildStore({ tickets: [closed] });

  await runInvestigation({
    ...wire(store),
    investigate: async () =>
      caseFile({ verdict: 'needs_human', handoff: { action: 'rembourser' }, established: [] }),
    shopId: 's1',
    anyStatus: true
  });

  assert.equal(store.saved.length, 1, 'the case file is written');
  const moved = store.updates.find((u) => u.patch?.status);
  assert.equal(moved, undefined, 'but the thread stays closed');
  const cleared = store.updates.find((u) => u.patch?.needs_investigation === false);
  assert.ok(cleared, 'and it leaves the queue, so a re-run does not find it again');
});

test('anyStatus reaches the claim, and nothing else widens with it', async () => {
  const filters = [];
  const record = createTicketRecord({}, {
    shopId: 's1',
    transport: {
      async select(_client, _table, where) {
        filters.push(where);
        return [];
      },
      async selectAll() {
        return [];
      },
      async insert(_client, _table, rows) {
        return rows;
      },
      async update() {
        return [];
      },
      async updateById() {
        return {};
      }
    }
  });

  await record.claim('investigation', { limit: 5 });
  await record.claim('investigation', { limit: 5, anyStatus: true });

  assert.equal(filters[0].status, 'open', 'the worker still sees open tickets only');
  assert.equal(filters[1].status, undefined, 'the widened claim drops the status narrowing');
  for (const where of filters) {
    assert.deepEqual(where.needs_investigation, { operator: 'is', value: 'true' });
    assert.deepEqual(where.needs_categorisation, { operator: 'is', value: 'false' });
    assert.deepEqual(where.archived_at, { operator: 'is', value: 'null' });
    assert.deepEqual(where.deleted_at, { operator: 'is', value: 'null' });
  }
});

test('answerable leaves the ticket open, because nothing has been sent', async () => {
  // The verdict says a reply COULD be written. Drafting is Phase 5; moving it out
  // of the queue now would mark work as handled that no customer has received.
  const store = buildStore();
  await runInvestigation({
    ...wire(store),
    investigate: async () => caseFile(),
    shopId: 's1'
  });

  const patch = store.updates.find((u) => u.patch?.status);
  assert.equal(patch, undefined, 'no status was written');
});

// --- what the reaction record has to survive ---------------------------------
//
// THE COLUMN, NOT THE CASE FILE. Every other test here hands `saveCaseFile` a
// fake store and asserts what the runner passed it, which never reaches the row
// mapping — and the row mapping is the whole of this feature's persistence: the
// tool's `data` is dropped from `tool_calls`, so a `reaction_report` that fails
// to reach its own column is a product and a set of symptoms lost at the end of
// the run, silently, with the case file looking correct.
test('the reaction record reaches its own column, and null when there is none', async () => {
  const rows = [];
  const store = createCaseFileStore(null, {
    transport: {
      upsert: async (_client, _table, payload) => {
        rows.push(payload[0]);
        return payload;
      }
    }
  });

  const report = {
    outcome: 'identified',
    product: 'Crème Yeux Anti-Âge',
    claimed: 'la crème pour les yeux',
    reaction: 'rougeurs et picotements',
    alternatives: []
  };

  const base = {
    ticket: { id: 't1', customer_id: null },
    shopId: 's1',
    triggerMessageId: 'm1'
  };
  await store.saveCaseFile({ ...base, caseFile: { ...caseFile(), reactionReport: report } });
  await store.saveCaseFile({ ...base, caseFile: caseFile() });

  assert.deepEqual(rows[0].reaction_report, report);
  // NULL, NOT `{}` — the empty object would have to mean both "no reaction was
  // reported" and "one was, and nothing was identified", and the second is a
  // finding a rule acts on.
  assert.equal(rows[1].reaction_report, null);
});

test('the situation is matched on the opening message, not the latest one', async () => {
  // THE TWO QUESTIONS ARE DIFFERENT. The investigation answers « what does this
  // customer need now » and is driven by the newest message; the matcher answers
  // « what is this thread about », which is the request that opened it.
  //
  // MEASURED on the ticket that exposed it: a thread opening « ma commande #6686
  // n'est toujours pas traitée » and closing « je vous confirme que j'ai bien
  // reçu ma commande » scored 0.623 against an address-change situation on the
  // last message, and 0.869 against O-09 on the first.
  const store = buildStore({
    messages: [
      { id: 'm1', body_text: "ma commande n'est toujours pas traitée", subject: 'Commande 6686' },
      { id: 'm2', body_text: "merci, j'ai bien reçu ma commande", subject: 'RE: Commande 6686' }
    ]
  });

  let matchedOn = null;
  let investigatedOn = null;
  await runInvestigation({
    ...wire(store),
    investigate: async (input) => {
      investigatedOn = input.text;
      return caseFile();
    },
    shopId: 's1',
    retrieveExemplar: async ({ body }) => {
      matchedOn = body;
      return EXEMPLAR_RESULT;
    }
  });

  assert.match(matchedOn, /toujours pas traitée/, 'the matcher reads the opening message');
  assert.match(investigatedOn, /bien reçu/, 'the investigation still reads the latest');

  // And the case file is still keyed to the trigger, which is the newest
  // message: changing what the matcher reads must not move where the row lands.
  assert.equal(store.saved[0].triggerMessageId, 'm2');
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { T } from '../../../scripts/lib/tables.mjs';

import { runRehearsal } from './run-rehearsal.mjs';

/**
 * The orchestrator, actually executed.
 *
 * WHY THIS EXISTS AND WHY IT LOOKS LIKE THIS. Every other module here is tested
 * in isolation, which proves each part and nothing about the wiring — and the
 * wiring is what a rehearsal IS: six passes, four stores, one substituted
 * database and a decorated client, in the poll's order. A run that has only ever
 * been reasoned about is the piece most likely to be wrong.
 *
 * So the two edges are stubbed and everything between them is real: `fetch`
 * answers every PostgREST call with an empty result (the passes' own "nothing
 * found" path, which is the branch a shop with no matching data takes), and the
 * OpenAI client is scripted per pass. No network, no database, no key.
 */

const SHOP = 'shop-1';

const CONFIG = {
  // No key: the injected client stands in for one.
  openaiApiKey: null,
  triageModel: 'test-triage',
  categoriserModel: 'test-categoriser',
  investigatorModel: 'test-investigator',
  investigationMaxToolCalls: 6,
  investigationMaxTurns: 2,
  // Absent, so the investigation treats the email as a single request — one
  // fewer scripted call, and the path most tickets take.
  decomposerModel: null,
  draftingModel: 'test-drafter',
  embeddingModel: 'test-embed',
  embeddingDimensions: 1536,
  graph: { mailbox: 'support@qiriness.test' }
};

const BRAND_VOICE = {
  approvalStatus: 'approved',
  roleDescription: 'agent',
  toneAndVoice: 'chaleureux',
  responseFramework: ['saluer'],
  guidelinesAndGuardrails: ['ne rien inventer'],
  closingLine: 'Belle journée,',
  signature: 'Qiriness',
  generalContext: ''
};

const CASE_FILE = {
  verdict: 'needs_customer_input',
  established: [],
  unverified: [],
  // The field name matters: `buildCaseFile` downgrades needs_customer_input to
  // needs_human when nothing valid was named to ask for, so an invented key here
  // would silently change the verdict under the test.
  missing: [{ field: 'shopify_order_number', why: "Le client n'a pas donné de numéro." }],
  handoff: null
};

/** A client scripted per pass, so each call can be asserted rather than guessed. */
function scriptedOpenAI({ label = 'legitimate' } = {}) {
  const seen = [];
  return {
    seen,
    async completeJson({ pass }) {
      seen.push(pass);
      if (pass === 'spam') return { label, reason: 'un vrai client' };
      if (pass === 'categorise') {
        return {
          category: 'product',
          request_kind: 'question',
          level: 1,
          language: 'fr',
          happiness: 'neutral',
          reason: 'question produit'
        };
      }
      if (pass === 'draft') {
        return { subject: null, body: 'Bonjour,\n\nPourriez-vous nous donner votre numéro de commande ?\n\nBelle journée,\nQiriness' };
      }
      throw new Error(`unscripted completeJson pass: ${pass}`);
    },
    async completeWithTools({ pass, schema }) {
      seen.push(pass);
      // The investigation's loop: no tool requests, then the case file on the
      // turn that carries the schema.
      if (schema) {
        return { message: {}, content: JSON.stringify(CASE_FILE), toolCalls: [], usage: null };
      }
      return { message: {}, content: null, toolCalls: [], usage: null };
    }
  };
}

const embeddingsClient = { async embed(inputs) { return inputs.map(() => new Array(4).fill(0)); } };

/** Every PostgREST read answers empty; nothing is written anywhere. */
function stubFetch() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    return {
      ok: true,
      status: 200,
      async json() {
        return [];
      },
      async text() {
        return '[]';
      }
    };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const supabase = { baseUrl: 'http://supabase.test/rest/v1', key: 'sb_secret_test' };

async function rehearse(overrides = {}) {
  const openaiClient = overrides.openaiClient ?? scriptedOpenAI();
  const http = stubFetch();
  try {
    const steps = [];
    const result = await runRehearsal({
      supabase,
      shopId: SHOP,
      config: CONFIG,
      brandVoice: BRAND_VOICE,
      input: { name: 'Marie Durand', email: 'marie@example.fr', subject: 'Question', body: 'Bonjour, une question sur un produit.' },
      onStep: (event) => steps.push(event),
      openaiClient,
      embeddingsClient,
      ...overrides
    });
    return { result, steps, http, openaiClient };
  } finally {
    http.restore();
  }
}

const typesOf = (steps) => steps.map((step) => step.type);

test('a rehearsal runs every pass, in the poll order, and completes', async () => {
  const { result, steps } = await rehearse();

  assert.equal(result.status, 'complete');
  assert.equal(result.error, null);

  const types = typesOf(steps);
  // The order is the finding as often as the content is.
  for (const [before, after] of [
    ['input', 'gate'],
    ['gate', 'identity'],
    ['identity', 'categorise'],
    // THE FIX THIS TEST NOW GUARDS. The order passes run before the
    // investigation, so the case file is written with the order in hand.
    // They used to run after it, which meant every first email quoting an
    // order number was investigated as though no order existed.
    ['categorise', 'order_resolution'],
    ['order_resolution', 'order_context'],
    ['order_context', 'case_file'],
    ['case_file', 'draft']
  ]) {
    assert.ok(
      types.indexOf(before) >= 0 && types.indexOf(before) < types.indexOf(after),
      `${before} should come before ${after} — got ${types.join(' → ')}`
    );
  }
});

test('it reports the labels, the verdict and the reply it produced', async () => {
  const { result, steps } = await rehearse();

  assert.equal(result.summary.category, 'product');
  assert.equal(result.summary.requestKind, 'question');
  assert.equal(result.summary.level, 1);
  assert.equal(result.summary.language, 'fr');
  assert.equal(result.summary.verdict, 'needs_customer_input');
  assert.match(result.summary.draftBody, /numéro de commande/);

  const draft = steps.find((step) => step.type === 'draft');
  assert.equal(draft.skipped, undefined);
  // Derived from the verdict, never chosen by the model: a question is waiting
  // on an answer, so sending it cannot end the exchange.
  assert.equal(draft.disposition, 'intermediary');
});

test('every pass ran through the traced client, so its prompts are on the run', async () => {
  const { openaiClient, steps } = await rehearse();

  assert.deepEqual(openaiClient.seen, ['spam', 'categorise', 'investigate', 'investigate', 'draft']);
  // And each of those calls is attached to the step that made it.
  for (const type of ['gate', 'categorise', 'draft']) {
    const step = steps.find((event) => event.type === type);
    assert.ok(step.calls?.length > 0, `${type} should carry the calls it made`);
    assert.ok(step.calls[0].system, 'the system prompt is what was actually sent');
  }
});

test('IT WRITES NOTHING: no row is created anywhere in the support schema', async () => {
  // The property the whole feature rests on. The ticket, the case file and the
  // draft live in the memory transport and are discarded with the run.
  //
  // The verb alone cannot say this: PostgREST takes an RPC as a POST, so the
  // vector searches and `order_number_range` are POSTs that read. The claim is
  // about the TABLES — anything that is not a GET and not `/rpc/` would be a
  // write, and no table may be written at all.
  const { http } = await rehearse();

  const writes = http.calls.filter(
    (call) => call.method !== 'GET' && !call.url.includes('/rpc/')
  );
  assert.deepEqual(writes, [], `a rehearsal must not write: ${JSON.stringify(writes)}`);

  for (const table of [T.TICKETS, T.TICKET_MESSAGES, T.TICKET_INVESTIGATIONS, T.TICKET_DRAFTS]) {
    const touched = http.calls.filter((call) => call.url.includes(`/${table}?`));
    assert.deepEqual(touched, [], `${table} must not be touched over the network`);
  }

  assert.ok(http.calls.length > 0, 'it should still have read real data');
  // And the tools really ran: retrieval reached the knowledge vectors.
  assert.ok(
    http.calls.some((call) => call.url.includes('match_knowledge_chunks')),
    'the knowledge tool should have searched'
  );
});

test('the gate stopping the run is an outcome, not a failure', async () => {
  const { result, steps } = await rehearse({ openaiClient: scriptedOpenAI({ label: 'spam' }) });

  assert.equal(result.status, 'gated');
  assert.equal(result.summary.gateOutcome, 'blocked');
  // Nothing after the gate ran, which is the honest report: a real email judged
  // this way never becomes a ticket.
  assert.deepEqual(typesOf(steps), ['input', 'gate']);
});

test('pastGate carries a blocked message through the rest of the pipeline', async () => {
  const { result, steps } = await rehearse({
    openaiClient: scriptedOpenAI({ label: 'spam' }),
    pastGate: true
  });

  assert.equal(result.status, 'complete');
  // The finding is kept even though the operator overrode it.
  assert.equal(result.summary.gateOutcome, 'blocked');
  assert.ok(typesOf(steps).includes('draft'));
});

test('an unapproved brand voice stops at the draft and says why', async () => {
  const { result, steps } = await rehearse({
    brandVoice: { ...BRAND_VOICE, approvalStatus: 'in_review' }
  });

  assert.equal(result.status, 'complete');
  const draft = steps.find((step) => step.type === 'draft');
  assert.equal(draft.skipped, true);
  assert.equal(draft.reason, 'brand_voice');
  assert.match(draft.note, /not approved/);
  // Everything before it still ran — which is most of what the tool is for.
  assert.equal(result.summary.verdict, 'needs_customer_input');
});

test('the run is streamed: every step reaches onStep as it lands', async () => {
  const { result, steps } = await rehearse();
  // The stream and the stored record are the same events, not two renderings.
  assert.deepEqual(typesOf(steps), typesOf(result.trace));
});

test('a message with no address still runs, with the sender unknown', async () => {
  const { result, steps } = await rehearse({
    input: { name: '', email: '', subject: 'Bonjour', body: 'Une question.' }
  });

  assert.equal(result.status, 'complete');
  const identity = steps.find((step) => step.type === 'identity');
  // Nothing to resolve, so the pass has nothing to do — not a failure.
  assert.equal(identity.linked, false);
});

test('an order number typed in the field is in the message the passes read', async () => {
  const { steps } = await rehearse({
    input: {
      name: 'Marie',
      email: 'marie@example.fr',
      subject: 'Retard',
      body: 'Ma commande est en retard.',
      orderNumber: '#1006'
    }
  });

  const input = steps.find((step) => step.type === 'input');
  assert.match(input.body, /#1006/);
  assert.equal(input.orderNumberAppended, true);
});

test('a model failure is absorbed by the pass, exactly as it is in the worker', async () => {
  // NOT a failed run, and the difference is the point. `runCategorisation`
  // retries three times and then falls back TOWARDS A HUMAN — (other, problem),
  // level 3 — rather than propagating. A rehearsal that reported this as "the
  // test crashed" would hide the behaviour a real rate limit produces.
  const client = scriptedOpenAI();
  const original = client.completeJson.bind(client);
  client.completeJson = async (args) => {
    if (args.pass === 'categorise') throw new Error('rate limited');
    return original(args);
  };

  const { result, steps } = await rehearse({ openaiClient: client });

  assert.equal(result.status, 'complete');

  // ONE POLL IS ONE ATTEMPT. The pass retries across polls — three before it
  // falls back to (other, problem) at level 3 — so a rehearsal's first failure
  // leaves the ticket unlabelled and still queued. The transcript has to SAY
  // that, or a failed model call renders as a blank categorisation card.
  const categorise = steps.find((step) => step.type === 'categorise');
  assert.equal(categorise.failed, true);
  assert.match(categorise.note, /retries it/);
  assert.equal(result.summary.category, null);

  // And nothing downstream was handed a guess to work from.
  const caseFile = steps.find((step) => step.type === 'case_file');
  assert.equal(caseFile.skipped, true);
  assert.equal(caseFile.reason, 'not_queued_for_investigation');
});

test('a failure outside any pass fails the run and is recorded as a step', async () => {
  // The other half: a store read that throws is nobody's to retry, so the run
  // ends and says so rather than rendering half a transcript with no explanation.
  const original = globalThis.fetch;
  const { result, steps } = await (async () => {
    const openaiClient = scriptedOpenAI();
    globalThis.fetch = async (url) => {
      if (String(url).includes('/rpc/order_number_range')) {
        throw new Error('supabase unreachable');
      }
      return { ok: true, status: 200, async json() { return []; }, async text() { return '[]'; } };
    };
    try {
      const steps = [];
      const result = await runRehearsal({
        supabase,
        shopId: SHOP,
        config: CONFIG,
        brandVoice: BRAND_VOICE,
        input: { name: 'Marie', email: 'marie@example.fr', subject: 'Q', body: 'Une question.' },
        onStep: (event) => steps.push(event),
        openaiClient,
        embeddingsClient
      });
      return { result, steps };
    } finally {
      globalThis.fetch = original;
    }
  })();

  assert.equal(result.status, 'failed');
  assert.match(result.error, /supabase unreachable/);
  assert.ok(steps.some((step) => step.type === 'error'));
  // Everything that ran before it is still on the transcript.
  assert.ok(typesOf(steps).includes('categorise'));
});

test('the memory transport, not the database, is what held the run', async () => {
  // A guard against the substitution silently reverting: if the real transport
  // were reinstated, the ticket read below would be a network call and the
  // assertion above about writes would be the only thing left standing.
  const { http } = await rehearse();
  const ticketReads = http.calls.filter((call) => call.url.includes(`/${T.TICKETS}?`));
  assert.deepEqual(ticketReads, [], 'the synthetic ticket must never be read over the network');
});

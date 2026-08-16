import assert from 'node:assert/strict';
import test from 'node:test';

import { report, toClusterRecords } from './cluster-ticket-messages.mjs';
import { buildClusterRows } from './lib/cluster-store.mjs';

// The report is the source of the stored map, so what is tested here is that
// the two agree: same excerpt, same sizes, and every message the report counted
// present in the row it counted it into.

const TICKETS = [
  { id: 't1', category: 'order' },
  { id: 't2', category: 'delivery' }
];

// Three-dimensional vectors, not 1536: the clustering maths is cosine on
// whatever it is handed, and hand-picked angles make the expected grouping
// something a reader can verify rather than take on trust.
const MESSAGES = [
  // m1 and m2 are the same email twice — collapsed by the 0.97 dedupe pass.
  { id: 'm1', ticket_id: 't1', from_email: 'client@example.test', body_text: '  Bonjour,\n\n je nai   toujours pas recu ma commande  ', embedding: '[1,0,0]' },
  { id: 'm2', ticket_id: 't1', from_email: 'client@example.test', body_text: 'Bonjour, je nai toujours pas recu ma commande', embedding: '[1,0,0]' },
  // Close enough to join the topic (cosine 0.8), far enough to stay distinct.
  { id: 'm3', ticket_id: 't1', from_email: 'autre@example.test', body_text: 'ou en est ma commande svp', embedding: '[0.8,0.6,0]' },
  { id: 'm4', ticket_id: 't2', from_email: 'client@example.test', body_text: 'le suivi nest plus mis a jour', embedding: '[0,1,0]' },
  { id: 'm5', ticket_id: 't2', from_email: 'client3@example.test', body_text: 'colis bloque depuis une semaine', embedding: '[0,0.8,0.6]' },
  // Ours, by the sender directory — must not be reported as customer demand.
  { id: 'm6', ticket_id: 't2', from_email: 'ops@qiriness.test', body_text: 'ci-joint les POD', embedding: '[0,0,1]' }
];

const SENDER_DIRECTORY = {
  size: 1,
  isNonDemand: (from) => String(from).endsWith('@qiriness.test')
};

const OPTIONS = {
  threshold: 0.68,
  minSize: 2,
  dedupe: 0.97,
  show: 3,
  subject: null,
  audience: 'customer'
};

/**
 * PostgREST at the fetch boundary, honouring the `Range` header the paged
 * reader advances by — a stub that ignores it returns the same page for ever
 * and hangs the test rather than failing it.
 */
function stubSupabase(rowsByTable) {
  const original = globalThis.fetch;

  globalThis.fetch = async (url, init) => {
    const table = new URL(String(url)).pathname.split('/').pop();
    const from = Number(String(init?.headers?.Range || '0-').split('-')[0]);
    const rows = rowsByTable[table] || [];
    return { ok: true, status: 200, json: async () => rows.slice(from) };
  };

  return {
    supabase: { baseUrl: 'https://db.test/rest/v1', key: 'test-key' },
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

/** Runs the report with the terminal captured, so the suite stays readable. */
async function runReport(options = OPTIONS) {
  const { supabase, restore } = stubSupabase({
    tickets: TICKETS,
    ticket_messages: MESSAGES,
    knowledge_chunks: []
  });
  const printed = [];
  const log = console.log;
  console.log = (...args) => printed.push(args.join(' '));

  try {
    const result = await report({ supabase, options, senderDirectory: SENDER_DIRECTORY });
    return { result, printed: printed.join('\n') };
  } finally {
    console.log = log;
    restore();
  }
}

test('the run facts count what the report saw and what it left out', async () => {
  const { result } = await runReport();

  assert.equal(result.facts.messageCount, 5);
  assert.equal(result.facts.internalExcluded, 1);
  assert.equal(result.facts.subjectCount, 2);
  assert.equal(result.facts.topicCount, 2);
  // The settings that produced this map travel with it.
  assert.equal(result.facts.threshold, 0.68);
  assert.equal(result.facts.minSize, 2);
  assert.equal(result.facts.dedupe, 0.97);
});

test('internal_excluded is zero on the audiences that exclude nobody', async () => {
  for (const audience of ['internal', 'all']) {
    const { result } = await runReport({ ...OPTIONS, audience });
    assert.equal(result.facts.internalExcluded, 0, audience);
  }
});

test('a collapsed near-duplicate is still a member of the topic it stands for', async () => {
  const { result } = await runReport();
  const order = result.clusters.find((cluster) => cluster.subject === 'order');

  // m2 was collapsed into m1 before clustering, and `size` counts it — so the
  // stored members have to count it too, or the GIN lookup "which cluster holds
  // this message?" answers nothing for every duplicate.
  assert.equal(order.size, 3);
  assert.deepEqual([...order.memberMessageIds].sort(), ['m1', 'm2', 'm3']);
  assert.equal(order.memberMessageIds.length, order.size);
});

test('the stored excerpt is the one the report printed', async () => {
  const { result, printed } = await runReport();

  for (const cluster of result.clusters) {
    assert.ok(cluster.representativeExcerpt.length > 0);
    // Printed quoted; stored bare. Same whitespace collapsing, same cut.
    assert.ok(
      printed.includes(`"${cluster.representativeExcerpt}"`),
      `not printed: ${cluster.representativeExcerpt}`
    );
  }
  assert.match(
    result.clusters.find((cluster) => cluster.subject === 'order').representativeExcerpt,
    /^Bonjour, je nai toujours pas recu ma commande$/
  );
});

test('the internal sender never reaches a stored topic', async () => {
  const { result } = await runReport();
  const members = result.clusters.flatMap((cluster) => cluster.memberMessageIds);
  assert.ok(!members.includes('m6'));
});

test('cluster_index ranks within a subject, not across the run', () => {
  const records = toClusterRecords([
    { subject: 'order', groups: [{ size: 9 }, { size: 4 }] },
    { subject: 'delivery', groups: [{ size: 6 }] }
  ]);

  assert.deepEqual(
    records.map((record) => [record.subject, record.clusterIndex]),
    [
      ['order', 0],
      ['order', 1],
      ['delivery', 0]
    ]
  );
});

test('the records the report returns are exactly what the store can insert', async () => {
  const { result } = await runReport();
  const rows = buildClusterRows({ shopId: 'shop-1', runId: 'run-1', clusters: result.clusters });

  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.ok(row.subject);
    assert.ok(Number.isInteger(row.cluster_index));
    assert.ok(row.size >= OPTIONS.minSize);
    assert.ok(row.cohesion > 0 && row.cohesion <= 1);
    assert.equal(row.member_message_ids.length, row.size);
  }
});

test('an empty corpus reports nothing and gives the caller nothing to save', async () => {
  const { supabase, restore } = stubSupabase({ tickets: [], ticket_messages: [], knowledge_chunks: [] });
  const log = console.log;
  console.log = () => {};

  try {
    assert.equal(await report({ supabase, options: OPTIONS, senderDirectory: SENDER_DIRECTORY }), null);
  } finally {
    console.log = log;
    restore();
  }
});

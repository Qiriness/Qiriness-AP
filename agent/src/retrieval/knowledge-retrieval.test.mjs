import assert from 'node:assert/strict';
import test from 'node:test';

import { createKnowledgeRetrieval } from './knowledge-retrieval.mjs';

function build({ rows = [], embed } = {}) {
  const calls = { embedded: [], rpc: [] };
  const supabase = { baseUrl: 'https://example.test/rest/v1', key: 'k' };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.rpc.push({ url, args: JSON.parse(init.body) });
    return { ok: true, json: async () => rows };
  };

  const retrieve = createKnowledgeRetrieval({
    supabase,
    embeddingsClient: {
      async embed(inputs) {
        calls.embedded.push(...inputs);
        return embed ? embed(inputs) : [[0.1, 0.2, 0.3]];
      }
    }
  });

  return { retrieve, calls, restore: () => { globalThis.fetch = originalFetch; } };
}

const TICKET = { subject: 'Masque LED', body: 'Est-il utilisable tous les jours ?', category: 'product' };

test('a ticket is embedded once and searched in its own category plus faq', async () => {
  const { retrieve, calls, restore } = build({
    rows: [{ chunk_id: 'c1', document_title: 'FAQ', chunk_text: 'Oui.', similarity: 0.71, category: 'faq' }]
  });

  try {
    const result = await retrieve(TICKET, { shopId: 'shop-1' });

    assert.equal(calls.embedded.length, 1, 'exactly one embedding call');
    assert.match(calls.embedded[0], /Masque LED/);
    assert.match(calls.rpc[0].url, /\/rpc\/match_knowledge_chunks$/);
    assert.deepEqual(calls.rpc[0].args.match_categories, ['product', 'faq']);
    assert.equal(calls.rpc[0].args.match_shop_id, 'shop-1');
    assert.equal(result.answerable, true);
    assert.equal(result.chunks[0].title, 'FAQ');
  } finally {
    restore();
  }
});

test('the vector is sent as a pgvector literal, not a JS array', async () => {
  const { retrieve, calls, restore } = build({ rows: [] });
  try {
    await retrieve(TICKET, { shopId: 'shop-1' });
    assert.equal(typeof calls.rpc[0].args.query_embedding, 'string');
    assert.match(calls.rpc[0].args.query_embedding, /^\[.*\]$/);
  } finally {
    restore();
  }
});

test('it over-fetches so a weak chunk cannot crowd out a better one', async () => {
  const { retrieve, calls, restore } = build({ rows: [] });
  try {
    await retrieve(TICKET, { shopId: 'shop-1', limit: 3 });
    assert.ok(calls.rpc[0].args.match_count >= 6, 'asks for more than it will show');
  } finally {
    restore();
  }
});

test('nothing found is reported honestly rather than as a weak answer', async () => {
  const { retrieve, restore } = build({ rows: [] });
  try {
    const result = await retrieve(TICKET, { shopId: 'shop-1' });
    assert.deepEqual(result, { answerable: false, verdict: 'none', bestSimilarity: null, chunks: [] });
  } finally {
    restore();
  }
});

test('a weak-only match is surfaced as weak, never as answerable', async () => {
  // The measured failure mode: topics with no article still scored 0.38-0.48.
  const { retrieve, restore } = build({
    rows: [{ chunk_id: 'c1', document_title: 'CGV', chunk_text: '...', similarity: 0.5, category: 'faq' }]
  });
  try {
    const result = await retrieve(TICKET, { shopId: 'shop-1' });
    assert.equal(result.answerable, false);
    assert.equal(result.verdict, 'weak');
  } finally {
    restore();
  }
});

test('an empty ticket costs no embedding call and no query', async () => {
  const { retrieve, calls, restore } = build({ rows: [] });
  try {
    const result = await retrieve({ subject: '', body: '', category: 'product' }, { shopId: 'shop-1' });
    assert.equal(result.answerable, false);
    assert.equal(calls.embedded.length, 0, 'no tokens spent on nothing');
    assert.equal(calls.rpc.length, 0);
  } finally {
    restore();
  }
});

test('the sender is never part of what gets embedded', async () => {
  // Personal-data minimisation: the query is the same subject+body the
  // categoriser already reads, never the address or name.
  const { retrieve, calls, restore } = build({ rows: [] });
  try {
    await retrieve(
      { ...TICKET, from_email: 'client@example.com', from_name: 'Marie Dupont' },
      { shopId: 'shop-1' }
    );
    assert.doesNotMatch(calls.embedded[0], /client@example\.com|Marie Dupont/);
  } finally {
    restore();
  }
});

test('an RPC failure surfaces rather than being swallowed as "no answer"', async () => {
  // Silently returning "nothing found" on an outage would look identical to a
  // genuinely empty library, and quietly route everything to a human forever.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ message: 'boom' }) });

  const retrieve = createKnowledgeRetrieval({
    supabase: { baseUrl: 'https://example.test/rest/v1', key: 'k' },
    embeddingsClient: { async embed() { return [[0.1]]; } }
  });

  try {
    await assert.rejects(() => retrieve(TICKET, { shopId: 'shop-1' }), /match_knowledge_chunks failed: boom/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

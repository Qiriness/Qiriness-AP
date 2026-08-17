import assert from 'node:assert/strict';
import test from 'node:test';

import { createShopUsageRecording, createUsageStore } from './usage-store.mjs';
import { createUsageSink } from './usage-sink.mjs';

// A fake PostgREST at the fetch boundary, so the real REST client is exercised
// and no network is touched — the house pattern.
function fakeSupabase({ fail = false } = {}) {
  const posted = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, init) => {
    posted.push({ url: String(url), body: JSON.parse(init.body) });
    if (fail) {
      return { ok: false, status: 500, text: async () => 'boom', json: async () => ({}) };
    }
    return { ok: true, status: 201, text: async () => '[]', json: async () => [] };
  };

  return {
    client: { baseUrl: 'https://example.test/rest/v1', key: 'k' },
    posted,
    restore: () => {
      globalThis.fetch = originalFetch;
    }
  };
}

const entry = (over = {}) => ({
  pass: 'categorise',
  model: 'gpt-4o-mini',
  ticketId: 't-1',
  inputTokens: 900,
  outputTokens: 100,
  totalTokens: 1000,
  callCount: 1,
  succeeded: true,
  errorKind: null,
  occurredAt: '2026-08-16T10:00:00.000Z',
  ...over
});

test('writes one insert for the whole drain', async () => {
  const fake = fakeSupabase();
  try {
    const store = createUsageStore(fake.client, { shopId: 'shop-1' });
    const written = await store.flush([entry(), entry({ ticketId: 't-2' })]);

    assert.equal(written, 2);
    assert.equal(fake.posted.length, 1, 'a busy poll must not become one request per call');
    assert.match(fake.posted[0].url, /llm_usage/);
    assert.equal(fake.posted[0].body.length, 2);
  } finally {
    fake.restore();
  }
});

test('maps a sink entry onto the table\'s columns', async () => {
  const fake = fakeSupabase();
  try {
    await createUsageStore(fake.client, { shopId: 'shop-1' }).flush([entry()]);
    assert.deepEqual(fake.posted[0].body[0], {
      shop_id: 'shop-1',
      ticket_id: 't-1',
      pass: 'categorise',
      model: 'gpt-4o-mini',
      input_tokens: 900,
      output_tokens: 100,
      total_tokens: 1000,
      call_count: 1,
      succeeded: true,
      error_kind: null,
      occurred_at: '2026-08-16T10:00:00.000Z'
    });
  } finally {
    fake.restore();
  }
});

test('keeps each call\'s own timestamp rather than the flush\'s', async () => {
  // A batch stamped at flush time would collapse a whole poll into one instant
  // and make "how long did this ticket take" unanswerable.
  const fake = fakeSupabase();
  try {
    await createUsageStore(fake.client, { shopId: 'shop-1' }).flush([
      entry({ occurredAt: '2026-08-16T10:00:00.000Z' }),
      entry({ occurredAt: '2026-08-16T10:04:00.000Z' })
    ]);
    assert.deepEqual(
      fake.posted[0].body.map((r) => r.occurred_at),
      ['2026-08-16T10:00:00.000Z', '2026-08-16T10:04:00.000Z']
    );
  } finally {
    fake.restore();
  }
});

test('a write failure never reaches the pass that did the work', async () => {
  // The whole contract: the accountant may not abort the job.
  const fake = fakeSupabase({ fail: true });
  const warnings = [];
  try {
    const store = createUsageStore(fake.client, {
      shopId: 'shop-1',
      logger: { warn: (event, detail) => warnings.push([event, detail]) }
    });

    const written = await store.flush([entry()]);
    assert.equal(written, 0);
    assert.equal(warnings[0][0], 'llm_usage.flush_failed');
    assert.equal(warnings[0][1].count, 1);
  } finally {
    fake.restore();
  }
});

test('nothing is written, and nothing fails, without a shop id', async () => {
  const fake = fakeSupabase();
  const warnings = [];
  try {
    const written = await createUsageStore(fake.client, {
      shopId: null,
      logger: { warn: (event) => warnings.push(event) }
    }).flush([entry()]);

    assert.equal(written, 0);
    assert.equal(fake.posted.length, 0);
    assert.deepEqual(warnings, ['llm_usage.flush_skipped']);
  } finally {
    fake.restore();
  }
});

test('an empty drain costs no request', async () => {
  const fake = fakeSupabase();
  try {
    const store = createUsageStore(fake.client, { shopId: 'shop-1' });
    assert.equal(await store.flush([]), 0);
    assert.equal(await store.flush(), 0);
    assert.equal(fake.posted.length, 0);
  } finally {
    fake.restore();
  }
});

// The bug these four cover: the sink and the store were both built, both tested,
// and never constructed together by anything that ran — so `llm_usage` held 0
// rows while three LLM passes worked the corpus. The pairing is the fix, so the
// pairing is what is pinned.
test('the shop recording hands out a sink whose calls reach the table', async () => {
  const fake = fakeSupabase();
  try {
    const usage = createShopUsageRecording({ supabase: fake.client, shopId: 'shop-1' });
    usage.sink.record({ pass: 'investigate', model: 'gpt-4o', ticketId: 't-9', usage: { prompt_tokens: 800, completion_tokens: 200, total_tokens: 1000 } });

    const spent = await usage.flush();

    assert.deepEqual(spent, { calls: 1, tokens: 1000, written: 1 });
    assert.equal(fake.posted.length, 1);
    assert.equal(fake.posted[0].body[0].pass, 'investigate');
    assert.equal(fake.posted[0].body[0].ticket_id, 't-9');
    assert.equal(fake.posted[0].body[0].shop_id, 'shop-1');
  } finally {
    fake.restore();
  }
});

test('write:false totals the spend and stores nothing', async () => {
  const fake = fakeSupabase();
  try {
    const usage = createShopUsageRecording({ supabase: fake.client, shopId: 'shop-1' });
    usage.sink.record({ pass: 'investigate', model: 'gpt-4o', usage: { total_tokens: 700 } });

    const spent = await usage.flush({ write: false });

    assert.deepEqual(spent, { calls: 1, tokens: 700, written: 0 });
    assert.equal(fake.posted.length, 0, 'a dry run must leave no rows behind');
    assert.equal(usage.sink.size, 0, 'entries describe calls already billed — never replayed');
  } finally {
    fake.restore();
  }
});

test('a failed write still drains, so the next flush cannot double-count', async () => {
  const fake = fakeSupabase({ fail: true });
  try {
    const usage = createShopUsageRecording({ supabase: fake.client, shopId: 'shop-1' });
    usage.sink.record({ pass: 'categorise', model: 'gpt-4o-mini', usage: { total_tokens: 100 } });

    const spent = await usage.flush();
    assert.deepEqual(spent, { calls: 1, tokens: 100, written: 0 });

    assert.deepEqual(await usage.flush(), { calls: 0, tokens: 0, written: 0 });
  } finally {
    fake.restore();
  }
});

test('an empty poll costs no request', async () => {
  const fake = fakeSupabase();
  try {
    const usage = createShopUsageRecording({ supabase: fake.client, shopId: 'shop-1' });
    assert.deepEqual(await usage.flush(), { calls: 0, tokens: 0, written: 0 });
    assert.equal(fake.posted.length, 0);
  } finally {
    fake.restore();
  }
});

test('a sink drains straight into the store', async () => {
  const fake = fakeSupabase();
  try {
    const sink = createUsageSink({ now: () => new Date('2026-08-16T10:00:00.000Z') });
    sink.record({ pass: 'embed', model: 'text-embedding-3-small', usage: { prompt_tokens: 300, total_tokens: 300 } });

    const written = await createUsageStore(fake.client, { shopId: 'shop-1' }).flush(sink.drain());
    assert.equal(written, 1);
    assert.equal(fake.posted[0].body[0].pass, 'embed');
    assert.equal(fake.posted[0].body[0].ticket_id, null);
    assert.equal(sink.size, 0);
  } finally {
    fake.restore();
  }
});

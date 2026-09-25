import assert from 'node:assert/strict';
import test from 'node:test';

import { connectKlaviyo, runKlaviyoSync } from './klaviyo-sync.mjs';

const SHOP = { id: 'shop-1' };
const KEY = 'pk_dummy0123456789abcdef0123';
const NOW = new Date('2026-09-25T10:00:00Z');

/** A PostgREST stand-in: records every request, answers from `respond`. */
function fakeSupabase(respond) {
  const calls = [];
  const client = { baseUrl: 'https://db.test/rest/v1', key: 'sb_secret_test' };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const payload = respond(call) ?? [];
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { client, calls, restore: () => (globalThis.fetch = original) };
}

function fakeKlaviyo(overrides = {}) {
  const seen = { flow: [], campaign: [] };
  const client = {
    listMetrics: async () => [{ id: 'PO', attributes: { name: 'Placed Order', integration: { name: 'Shopify' } } }],
    listCampaigns: async (channel) => (channel === 'email' ? [{ id: 'C1', attributes: { name: 'Rentrée', send_time: '2026-09-03T08:00:00Z' } }] : []),
    flowSeriesReport: async (body) => {
      seen.flow.push(body.data.attributes.timeframe);
      return {
        data: {
          attributes: {
            date_times: ['2026-09-20T00:00:00'],
            results: [{ groupings: { flow_id: 'F1', flow_name: 'Welcome' }, statistics: { recipients: [3], delivered: [3], clicks_unique: [1] } }]
          }
        }
      };
    },
    campaignValuesReport: async (body) => {
      seen.campaign.push(body.data.attributes.timeframe);
      return { data: { attributes: { results: [{ groupings: { campaign_id: 'C1', send_channel: 'email' }, statistics: { recipients: 10, clicks_unique: 2 } }] } } };
    },
    ...overrides
  };
  return { seen, create: () => client };
}

test('a key Klaviyo accepts is saved through the Vault function, with its hint and metric', async () => {
  const db = fakeSupabase(() => null);
  try {
    const out = await connectKlaviyo({ supabase: db.client, shopId: SHOP.id, key: KEY, createClient: fakeKlaviyo().create });
    assert.deepEqual(out, { ok: true, hint: '0123' });
    const save = db.calls.find((c) => c.url.endsWith('/rpc/klaviyo_save_key'));
    assert.deepEqual(save.body, { p_shop: SHOP.id, p_key: KEY, p_hint: '0123', p_metric_id: 'PO', p_saved_by: null });
  } finally {
    db.restore();
  }
});

test('a rejected key, or one without Placed Order, is never saved', async () => {
  const db = fakeSupabase(() => null);
  try {
    const rejected = Object.assign(new Error('401'), { status: 401 });
    const bad = await connectKlaviyo({ supabase: db.client, shopId: SHOP.id, key: KEY, createClient: () => ({ listMetrics: async () => { throw rejected; } }) });
    assert.match(bad.error, /rejected/);
    const noMetric = await connectKlaviyo({ supabase: db.client, shopId: SHOP.id, key: KEY, createClient: () => ({ listMetrics: async () => [] }) });
    assert.match(noMetric.error, /Placed Order/);
    const shape = await connectKlaviyo({ supabase: db.client, shopId: SHOP.id, key: 'nope', createClient: fakeKlaviyo().create });
    assert.equal(shape.ok, false);
    assert.equal(db.calls.length, 0);
  } finally {
    db.restore();
  }
});

test('no connection: the sync is skipped, not failed', async () => {
  const db = fakeSupabase(() => []);
  try {
    assert.deepEqual(await runKlaviyoSync({ supabase: db.client, shopRow: SHOP, now: NOW, createClient: fakeKlaviyo().create }), { skipped: 'not connected' });
  } finally {
    db.restore();
  }
});

function connected({ storedDays }) {
  return (call) => {
    if (call.url.includes('/klaviyo_connections') && call.method === 'GET') return [{ key_hint: '0123', conversion_metric_id: 'PO' }];
    if (call.url.endsWith('/rpc/klaviyo_read_key')) return KEY;
    if (call.url.includes('/klaviyo_flow_days') && call.method === 'GET') return storedDays ? [{ day: '2026-09-01' }] : [];
    return [];
  };
}

test('the first sync backfills a year of flow days; later ones rewrite one window', async () => {
  for (const [storedDays, windows] of [[false, 7], [true, 1]]) {
    const db = fakeSupabase(connected({ storedDays }));
    const klaviyo = fakeKlaviyo();
    try {
      const counts = await runKlaviyoSync({ supabase: db.client, shopRow: SHOP, now: NOW, log: () => {}, createClient: klaviyo.create });
      assert.equal(klaviyo.seen.flow.length, windows);
      assert.equal(counts.backfill, !storedDays);
      assert.equal(counts.campaigns, 1);
      const upserts = db.calls.filter((c) => c.method === 'POST' && !c.url.includes('/rpc/'));
      assert.ok(upserts.some((c) => c.url.includes('/klaviyo_flow_days')));
      assert.ok(upserts.some((c) => c.url.includes('/klaviyo_campaigns') && c.body[0].name === 'Rentrée'));
      const status = db.calls.find((c) => c.method === 'PATCH');
      assert.equal(status.body.last_sync_status, 'ok');
    } finally {
      db.restore();
    }
  }
});

test('a failure is recorded on the connection and thrown; a dry run writes nothing', async () => {
  const db = fakeSupabase(connected({ storedDays: true }));
  try {
    const broken = fakeKlaviyo({ campaignValuesReport: async () => { throw new Error('Klaviyo POST /campaign-values-reports/ failed: HTTP 403'); } });
    await assert.rejects(runKlaviyoSync({ supabase: db.client, shopRow: SHOP, now: NOW, log: () => {}, createClient: broken.create }), /403/);
    const status = db.calls.find((c) => c.method === 'PATCH');
    assert.equal(status.body.last_sync_status, 'failed');
    assert.match(status.body.last_sync_error, /403/);
  } finally {
    db.restore();
  }

  const dry = fakeSupabase(connected({ storedDays: true }));
  try {
    await runKlaviyoSync({ supabase: dry.client, shopRow: SHOP, now: NOW, dryRun: true, log: () => {}, createClient: fakeKlaviyo().create });
    assert.ok(dry.calls.every((c) => c.method === 'GET' || c.url.includes('/rpc/klaviyo_read_key')));
  } finally {
    dry.restore();
  }
});

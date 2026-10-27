import assert from 'node:assert/strict';
import test from 'node:test';

import { runStockAlert } from './stock-alert-mail.mjs';

/** A PostgREST stand-in: shops, products (only synced_at), stock_alerts, and the inventory RPC. */
function fakeSupabase({ shop, syncedAt, inventory }) {
  const state = { syncedAt, inventory, alerts: [] };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const table = parsed.pathname.split('/').pop();
    const method = init.method ?? 'GET';
    let body = [];
    if (table === 'insights_inventory_exceptions') body = state.inventory;
    else if (table === 'products') body = [{ synced_at: state.syncedAt }];
    else if (table === 'shops') body = [shop];
    else if (table === 'stock_alerts' && method === 'GET') {
      body = state.alerts.filter((a) => a.status === 'baseline' || a.status === 'sent').slice(-1);
    } else if (table === 'stock_alerts' && method === 'POST') {
      state.alerts.push(...JSON.parse(init.body));
      body = [];
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { client: { baseUrl: 'https://db.test/rest/v1', key: 'k' }, state, restore: () => (globalThis.fetch = original) };
}

const SHOP = {
  shop_name: 'Barbara Gould',
  iana_timezone: 'Europe/Paris',
  stock_alert_sender: 'contact@shop.example',
  stock_alert_recipients: [{ role: 'management' }, { email: 'buyer@outside.example' }]
};
const row = (id, stock, cover, units = 5) => ({ product_id: id, title: `Produit ${id}`, product_type: null, stock, units_out: units, cover_days: cover, synced_at: null });
const quiet = { info() {}, warn() {}, error() {} };
const admin = { listUsers: async () => [{ email: 'boss@shop.example', app_metadata: { dashboard_role: 'management' } }] };

test('first check is a silent baseline; the next sync with a new critical product mails the Excel file', async () => {
  const db = fakeSupabase({ shop: { ...SHOP }, syncedAt: '2026-10-28T07:00:00Z', inventory: [row('a', 0, null), row('b', 60, 30)] });
  const sent = [];
  const graphClient = { sendMail: async (mail) => sent.push(mail) };
  const run = () => runStockAlert({ supabase: db.client, graphClient, adminClient: admin, shopId: 'shop-a', logger: quiet, now: new Date('2026-10-28T08:00:00Z') });
  try {
    assert.deepEqual(await run(), { baseline: true });
    assert.equal(sent.length, 0);
    assert.deepEqual(db.state.alerts[0].out_product_ids, ['a']);

    // Same sync: not checked again.
    assert.deepEqual(await run(), { skipped: 'no_new_sync' });

    // Next nightly: b drops to 12 units (critical), c appears under 14 days.
    db.state.syncedAt = '2026-10-29T07:00:00Z';
    db.state.inventory = [row('a', 0, null), row('b', 12, 30), row('c', 80, 9)];
    assert.deepEqual(await run(), { sent: true, new: 2, listed: 3 });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].from, 'contact@shop.example');
    assert.deepEqual(sent[0].toRecipients, ['boss@shop.example', 'buyer@outside.example']);
    assert.equal(sent[0].attachments[0].name, 'barbara-gould-alerte-stock-2026-10-28.xlsx');
    assert.equal(sent[0].attachments[0].content.subarray(0, 2).toString(), 'PK');
    assert.match(sent[0].subject, /2 produits en rupture ou critiques/);
    const last = db.state.alerts.at(-1);
    assert.equal(last.status, 'sent');
    assert.deepEqual(last.new_product_ids.sort(), ['b', 'c']);

    // A sync where nothing new happened sends nothing.
    db.state.syncedAt = '2026-10-30T07:00:00Z';
    assert.deepEqual(await run(), { skipped: 'nothing_new' });
    assert.equal(sent.length, 1);
  } finally {
    db.restore();
  }
});

test('a failed send leaves the state, so the next sync sends again; no sender means nothing at all', async () => {
  const db = fakeSupabase({ shop: { ...SHOP }, syncedAt: 's1', inventory: [] });
  let fail = true;
  const sent = [];
  const graphClient = { sendMail: async (mail) => (fail ? Promise.reject(new Error('Graph sendMail failed: ErrorAccessDenied')) : sent.push(mail)) };
  const run = () => runStockAlert({ supabase: db.client, graphClient, adminClient: admin, shopId: 'shop-b', logger: quiet });
  try {
    await run(); // baseline, empty
    db.state.syncedAt = 's2';
    db.state.inventory = [row('a', 0, null)];
    assert.equal((await run()).sent, false);
    assert.equal(db.state.alerts.at(-1).status, 'failed');
    fail = false;
    db.state.syncedAt = 's3';
    assert.equal((await run()).sent, true);
    assert.equal(sent.length, 1);
  } finally {
    db.restore();
  }

  const unset = fakeSupabase({ shop: { ...SHOP, stock_alert_sender: null }, syncedAt: 's1', inventory: [row('a', 0, null)] });
  try {
    const result = await runStockAlert({ supabase: unset.client, graphClient: { sendMail: async () => assert.fail('sent') }, adminClient: admin, shopId: 'shop-c', logger: quiet });
    assert.deepEqual(result, { skipped: 'not_configured' });
    assert.equal(unset.state.alerts.length, 0);
  } finally {
    unset.restore();
  }
});

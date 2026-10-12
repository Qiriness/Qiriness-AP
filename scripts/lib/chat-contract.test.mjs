import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { checkChatContract, diffLines, runEveryView } from './chat-contract.mjs';

/** A pg-shaped client: lists `views`, fails the ones in `broken`, serves `schemaRows` to the schema query. */
function fakeClient({ views, broken = [], schemaRows = [] }) {
  const sql = [];
  return {
    sql,
    async query(text) {
      sql.push(text);
      if (/from pg_class c join pg_namespace n/.test(text)) return { rows: views.map((name) => ({ name })) };
      if (/format_type\(a\.atttypid/.test(text)) return { rows: schemaRows };
      const hit = broken.find((name) => text.includes(`chat."${name}"`));
      if (hit) throw new Error(`permission denied for ${hit}`);
      return { rows: [{ count: 1 }] };
    }
  };
}

const ROWS = [
  { view_name: 'orders', view_comment: 'One row per order.', column_name: 'order_id', data_type: 'uuid', column_comment: null },
  { view_name: 'orders', view_comment: 'One row per order.', column_name: 'carrier', data_type: 'text', column_comment: 'Canonical carrier.' }
];

test('every view is run read-only, rolled back, and only counted', async () => {
  const client = fakeClient({ views: ['orders', 'tickets'] });
  const results = await runEveryView(client);
  assert.deepEqual(results.map((r) => r.ok), [true, true]);
  const runs = client.sql.filter((s) => s.includes('chat."'));
  assert.equal(runs.length, 2);
  for (const run of runs) assert.match(run, /^select count\(\*\) from \(select \* from chat\."\w+" limit 1\) s$/);
  assert.equal(client.sql.filter((s) => s === 'begin read only').length, 2);
  assert.equal(client.sql.filter((s) => s === 'rollback').length, 2);
});

test('a view that fails as the chat role fails the check, and the others still run', async () => {
  const client = fakeClient({ views: ['orders', 'vip_customers', 'tickets'], broken: ['vip_customers'], schemaRows: ROWS });
  const result = await checkChatContract(client, 'chat.orders — One row per order.\n  order_id uuid\n  carrier text — Canonical carrier.');
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed.map((f) => f.view), ['vip_customers']);
  assert.equal(result.views, 3);
});

test('a change to what the model is shown fails the check, line by line', async () => {
  const client = fakeClient({ views: ['orders'], schemaRows: ROWS });
  const result = await checkChatContract(client, 'chat.orders — One row per order.\n  order_id uuid\n  carrier text — Carrier, e.g. Colissimo.');
  assert.equal(result.ok, false);
  assert.deepEqual(result.changed, ['-   carrier text — Carrier, e.g. Colissimo.', '+   carrier text — Canonical carrier.']);
});

test('no snapshot is not a pass', async () => {
  const result = await checkChatContract(fakeClient({ views: ['orders'], schemaRows: ROWS }), null);
  assert.equal(result.ok, false);
  assert.deepEqual(result.changed, []);
});

test('diffLines reports only lines that differ', () => {
  assert.deepEqual(diffLines('a\nb\nc', 'a\nc\nd'), ['- b', '+ d']);
  assert.deepEqual(diffLines('a\r\nb', 'a\nb'), []);
});

test('the committed snapshot exists and covers the chat views', () => {
  const file = new URL('../../supabase/chat-contract.snapshot.txt', import.meta.url);
  assert.ok(existsSync(file));
  const views = readFileSync(file, 'utf8').match(/^chat\.\w+/gm) || [];
  assert.ok(views.length >= 14, `expected the chat views, found ${views.length}`);
});

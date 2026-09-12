import assert from 'node:assert/strict';
import test from 'node:test';

import { RPC } from '../../scripts/lib/tables.mjs';

import { codeOnly, read } from './_shared.test.mjs';

const SQL = read('14_fulfilment_waiting');
const ANALYTICS = read('06_analytics');
const VIP = read('12_vip_rule');

/** One function's `create ... $$;` statement, verbatim. */
function statementOf(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  if (start < 0) return undefined;
  const end = sql.indexOf('\n$$;', start);
  return sql.slice(start, end + 4);
}

test('14 carries insights_fulfilment_buckets and nothing else', () => {
  const created = [...codeOnly(SQL).matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(created, ['insights_fulfilment_buckets']);
  assert.equal(RPC.INSIGHTS_FULFILMENT_BUCKETS, 'insights_fulfilment_buckets');
});

test('14 copies the function from 06 rather than retyping it', () => {
  // Byte-for-byte, the rule every incremental migration here follows: a fix made
  // in one file and not the other fails this.
  assert.equal(
    statementOf(SQL, 'insights_fulfilment_buckets'),
    statementOf(ANALYTICS, 'insights_fulfilment_buckets')
  );
});

test('it creates no table and writes no data', () => {
  const code = codeOnly(SQL);
  assert.doesNotMatch(code, /create table/i);
  assert.doesNotMatch(code, /\b(insert|update|delete)\b/i);
});

test('it is idempotent: replace, never add', () => {
  assert.match(codeOnly(SQL), /create or replace function/);
  assert.doesNotMatch(codeOnly(SQL), /create function public\./);
});

test('the function is revoked from the anon roles, granted to the service role, and commented', () => {
  assert.match(SQL, /revoke all on function public\.insights_fulfilment_buckets from public, anon, authenticated/);
  assert.match(SQL, /grant execute on function public\.insights_fulfilment_buckets to service_role/);
  assert.match(SQL, /comment on function public\.insights_fulfilment_buckets is/);
});

test('it pins its search_path and stays stable', () => {
  const statement = statementOf(SQL, 'insights_fulfilment_buckets');
  assert.match(statement, /set search_path = public/);
  assert.match(statement, /\nstable\n/);
});

test('the range still arrives as wall-clock timestamps plus a timezone', () => {
  const statement = statementOf(SQL, 'insights_fulfilment_buckets');
  assert.match(statement, /p_from timestamp,\n\s+p_to timestamp,\n\s+p_tz text/);
  assert.match(statement, /at time zone p_tz/);
});

test('the seventh bucket counts orders that have not shipped at all', () => {
  const statement = codeOnly(statementOf(SQL, 'insights_fulfilment_buckets'));
  assert.match(statement, /'Not shipped yet', 7, count\(\*\)/);
  // The whole point: no fulfilment has happened. A part-shipped order has a
  // duration and belongs in a duration bucket, not here.
  assert.match(statement, /t\.first_fulfilled_at is null/);
});

test('waiting is counted by exactly the rule open_orders uses', () => {
  // The bar and the "Orders waiting to ship" list sit on the same panel; if
  // these two conditions ever diverge, one of them is lying to the reader.
  const bucket = codeOnly(statementOf(SQL, 'insights_fulfilment_buckets'));
  const open = codeOnly(statementOf(VIP, 'open_orders'));
  for (const condition of [
    'o.cancelled_at is null',
    'o.closed_at is null',
    'o.fulfillment_status is not null',
    "o.fulfillment_status not in ('FULFILLED', 'RESTOCKED')"
  ]) {
    assert.ok(bucket.includes(condition), `the waiting bucket is missing: ${condition}`);
    assert.ok(open.includes(condition), `open_orders is missing: ${condition}`);
  }
});

test('an empty seventh bucket is absent rather than a zero row', () => {
  // Every other bucket only exists when something is in it; a count aggregate
  // with no rows would otherwise return a solitary 0.
  assert.match(codeOnly(SQL), /having count\(\*\) > 0/);
});

test('the six duration buckets are untouched', () => {
  const statement = codeOnly(statementOf(SQL, 'insights_fulfilment_buckets'));
  for (const [hours, label, order] of [
    [12, '<12h', 1],
    [24, '12-24h', 2],
    [48, '24-48h', 3],
    [72, '48-72h', 4],
    [96, '72-96h', 5]
  ]) {
    assert.ok(statement.includes(`when t.fulfilment_hours < ${hours} then '${label}'`), `${label} bucket changed`);
    assert.ok(statement.includes(`when t.fulfilment_hours < ${hours} then ${order}`), `${label} order changed`);
  }
  assert.match(statement, /else '>96h'/);
});

test('the channel filters apply to the waiting bucket too', () => {
  // A platform filter that silently stopped applying to one bar would make the
  // chart disagree with itself.
  const statement = codeOnly(statementOf(SQL, 'insights_fulfilment_buckets'));
  assert.match(statement, /p_channels is null or o\.sales_channel_handle = any\(p_channels\)/);
  assert.match(statement, /not \(o\.sales_channel_handle = any\(p_not_channels\)\)/);
});

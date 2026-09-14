import assert from 'node:assert/strict';
import test from 'node:test';

import { RPC } from '../../scripts/lib/tables.mjs';

import { INCREMENTAL_FILES, codeOnly, read } from './_shared.test.mjs';

const SQL = read('18_product_customer_mix');
const ANALYTICS = read('06_analytics');
const FUNCTION = 'insights_product_customer_mix';

/** Incremental migrations after 18, which may replace the function it first carried. */
const LATER = INCREMENTAL_FILES.filter((file) => Number(file.slice(0, 2)) > 18).map(read);
const supersededLater = LATER.some((sql) => sql.includes(`create or replace function public.${FUNCTION}(`));

/** One function's `create ... $$;` statement, verbatim. */
function statementOf(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  if (start < 0) return undefined;
  const end = sql.indexOf('\n$$;', start);
  return sql.slice(start, end + 4);
}

test('18 carries the product customer mix function and the contract names it', () => {
  const created = [...codeOnly(SQL).matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(created, [FUNCTION]);
  assert.equal(RPC.INSIGHTS_PRODUCT_CUSTOMER_MIX, FUNCTION);
});

test('18 copies the function from 06 rather than retyping it', () => {
  // Once a later migration replaces it, 18 stays the historical step it was —
  // already applied — and the newer file is the one that must match 06.
  assert.ok(statementOf(SQL, FUNCTION));
  if (supersededLater) return;
  assert.equal(statementOf(SQL, FUNCTION), statementOf(ANALYTICS, FUNCTION));
});

test('if 18 no longer matches 06, a later migration carries the function', () => {
  if (statementOf(SQL, FUNCTION) === statementOf(ANALYTICS, FUNCTION)) return;
  assert.ok(supersededLater, `${FUNCTION} differs between 06 and 18 and no later migration carries it`);
});

test('the all-products draft signature is dropped before the new one is created', () => {
  const code = codeOnly(SQL);
  const drop = code.indexOf(
    `drop function if exists public.${FUNCTION}(uuid, timestamp, timestamp, text, text[], text[]);`
  );
  assert.ok(drop >= 0, 'the six-argument draft is not dropped');
  assert.ok(drop < code.indexOf(`create or replace function public.${FUNCTION}(`));
});

test('it creates no table and writes no data', () => {
  const code = codeOnly(SQL);
  assert.doesNotMatch(code, /create table/i);
  assert.doesNotMatch(code, /\b(insert|update|delete)\b/i);
});

test('the function is revoked from anon roles, granted to service role, commented, stable and pinned', () => {
  assert.match(SQL, new RegExp(`revoke all on function public\\.${FUNCTION} from public, anon, authenticated`));
  assert.match(SQL, new RegExp(`grant execute on function public\\.${FUNCTION} to service_role`));
  assert.match(SQL, new RegExp(`comment on function public\\.${FUNCTION} is`));
  const statement = statementOf(SQL, FUNCTION);
  assert.match(statement, /set search_path = public/);
  assert.match(statement, /\nstable\n/);
});

test('the range still arrives as wall-clock timestamps plus a timezone', () => {
  const statement = statementOf(SQL, FUNCTION);
  assert.match(statement, /p_from timestamp,\n\s+p_to timestamp,\n\s+p_tz text/);
  assert.match(statement, /at time zone p_tz/);
});

test('one product per call, so the result cannot reach the row cap', () => {
  // The draft returned every product's split in one read, up to 8 rows each;
  // at the catalogue's size PostgREST's 1,000-row cap would have cut it silently.
  const statement = codeOnly(statementOf(SQL, FUNCTION));
  assert.match(statement, /p_product_id text,/);
  assert.match(statement, /where pl\.product_id = p_product_id/);
  assert.match(statement, /r\.other_rank <= 7/);
  assert.doesNotMatch(statement, /partition by/);
});

test('it counts people: identified customers, distinct, in three buckets that sum to the whole', () => {
  const statement = codeOnly(statementOf(SQL, FUNCTION));
  assert.match(statement, /o\.shopify_customer_id is not null/);
  assert.match(statement, /count\(distinct ro\.customer_key\) from ranged_orders ro\) as customers/);
  assert.match(statement, /count\(distinct pl\.customer_key\) as other_customers/);
  assert.match(
    statement,
    /greatest\(s\.customers - s\.only_customers - s\.with_other_customers, 0\)::bigint as without_customers/
  );
});

test('free lines are not purchases, on either side', () => {
  // One filter, applied where lines are read, so a sample can neither make a
  // buyer "with something else", appear in the ordered-with list, nor make
  // someone a buyer of the product itself.
  const statement = codeOnly(statementOf(SQL, FUNCTION));
  const filter = "coalesce((li.value ->> 'discounted_total')::numeric, 0) > 0";
  assert.equal(statement.split(filter).length - 1, 1, 'the free-line filter should appear exactly once');
  assert.doesNotMatch(statement, /from ranged_orders ro\s+cross join lateral[\s\S]*from ranged_orders ro\s+cross join lateral/);
  for (const cte of ['buyers', 'buyer_sets', 'others']) {
    const body = statement.slice(statement.indexOf(`${cte} as (`));
    assert.match(body.slice(0, body.indexOf('),')), /paid_lines pl/, `${cte} must read paid_lines`);
  }
});

test('the channel filters apply, so the caller can remove marketplaces', () => {
  const statement = codeOnly(statementOf(SQL, FUNCTION));
  assert.match(statement, /p_channels is null or o\.sales_channel_handle = any\(p_channels\)/);
  assert.match(statement, /not \(o\.sales_channel_handle = any\(p_not_channels\)\)/);
});

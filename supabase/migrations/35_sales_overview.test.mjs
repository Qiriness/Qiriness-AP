import assert from 'node:assert/strict';
import test from 'node:test';

import { RPC } from '../../scripts/lib/tables.mjs';
import { codeOnly, read } from './_shared.test.mjs';

const SQL = read('35_sales_overview');
const ANALYTICS = read('06_analytics');
const FUNCTIONS = ['insights_sales_overview', 'insights_promotions', 'insights_inventory_exceptions'];

/** One function's `create ... $$;` statement, verbatim. */
function statementOf(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  if (start < 0) return undefined;
  const end = sql.indexOf('\n$$;', start);
  return sql.slice(start, end + 4);
}

/** The body of one CTE, from `name as (` to the `),` that closes it. */
function cteOf(statement, name) {
  const start = statement.indexOf(`${name} as (`);
  if (start < 0) return undefined;
  return statement.slice(start, statement.indexOf('\n  ),', start));
}

const ORDER_FILTERS = [
  'o.deleted_at is null',
  'o.cancelled_at is null',
  "o.processed_at >= (p_from at time zone p_tz)",
  "o.processed_at < (p_to at time zone p_tz)"
];

test('35 carries the three functions and nothing else', () => {
  const created = [...codeOnly(SQL).matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(created, FUNCTIONS);
});

test('35 copies each function from 06 rather than retyping it', () => {
  for (const name of FUNCTIONS) {
    assert.ok(statementOf(SQL, name), name);
    assert.equal(statementOf(SQL, name), statementOf(ANALYTICS, name), name);
  }
});

test('the web reaches them through tables.mjs', () => {
  assert.equal(RPC.INSIGHTS_SALES_OVERVIEW, 'insights_sales_overview');
  assert.equal(RPC.INSIGHTS_PROMOTIONS, 'insights_promotions');
  assert.equal(RPC.INSIGHTS_INVENTORY_EXCEPTIONS, 'insights_inventory_exceptions');
});

test('it drops nothing, creates no table and writes no data', () => {
  const code = codeOnly(SQL);
  assert.doesNotMatch(code, /drop function/i);
  assert.doesNotMatch(code, /create table/i);
  assert.doesNotMatch(code, /\b(insert|update|delete)\b/i);
});

test('each is granted like every other analytics function', () => {
  for (const name of FUNCTIONS) {
    assert.match(SQL, new RegExp(`revoke all on function public\\.${name} from public, anon, authenticated`), name);
    assert.match(SQL, new RegExp(`grant execute on function public\\.${name} to service_role`), name);
    assert.match(SQL, new RegExp(`comment on function public\\.${name} is`), name);
    const statement = statementOf(SQL, name);
    assert.match(statement, /set search_path = public/, name);
    assert.match(statement, /\nstable\n/, name);
    // The ranged-reads convention: wall-clock timestamps plus the zone.
    assert.match(statement, /p_from timestamp,\n\s+p_to timestamp,\n\s+p_tz text/, name);
    assert.doesNotMatch(statement, /timestamptz,?\n\s+p_to/, name);
  }
});

test('the overview and the promotions read the range exactly as the orders summary does', () => {
  for (const name of ['insights_sales_overview', 'insights_promotions']) {
    const ranged = cteOf(codeOnly(statementOf(SQL, name)), 'ranged');
    assert.ok(ranged, `${name}: ranged not found`);
    for (const filter of ORDER_FILTERS) assert.ok(ranged.includes(filter), `${name}: ${filter}`);
    assert.match(ranged, /p_channels is null or o\.sales_channel_handle = any\(p_channels\)/, name);
    assert.match(ranged, /not \(o\.sales_channel_handle = any\(p_not_channels\)\)/, name);
  }
});

test('revenue is net of refunds, so discounted + full price is the summary revenue', () => {
  const overview = codeOnly(statementOf(SQL, 'insights_sales_overview'));
  const net = 'coalesce(r.total_price, 0) - coalesce(r.total_refunded, 0)';
  assert.equal(overview.split(net).length - 1, 2);
  assert.match(overview, /filter \(where coalesce\(r\.total_discounts, 0\) > 0\)/);
  assert.match(overview, /filter \(where coalesce\(r\.total_discounts, 0\) = 0\)/);
});

test('units sold are paid units; stock leaving counts every unit', () => {
  const overview = codeOnly(statementOf(SQL, 'insights_sales_overview'));
  assert.match(overview, /coalesce\(\(li\.value ->> 'discounted_total'\)::numeric, 0\) > 0/);
  // A sample leaves the shelf like a sale does, so the stock rate keeps free lines.
  const inventory = codeOnly(statementOf(SQL, 'insights_inventory_exceptions'));
  assert.doesNotMatch(inventory, /discounted_total/);
});

test('a marketplace order is never a new customer, and "new" looks at every channel', () => {
  const flagged = cteOf(codeOnly(statementOf(SQL, 'insights_promotions')), 'flagged');
  assert.ok(flagged);
  assert.match(flagged, /not \(r\.sales_channel_handle = any\(p_people_not_channels\)\)/);
  assert.match(flagged, /e\.processed_at < r\.processed_at/);
  assert.doesNotMatch(flagged, /e\.sales_channel_handle/);
});

test('full-price orders always come back as the one null-named row', () => {
  const statement = codeOnly(statementOf(SQL, 'insights_promotions'));
  assert.match(statement, /null::text as promotion/);
  assert.match(statement, /where not exists \(select 1 from applied a where a\.id = f\.id\)/);
  assert.match(statement, /union all\n\s+select \* from full_price/);
});

test('stock is judged on active products only, and the thresholds are the caller\'s', () => {
  const statement = codeOnly(statementOf(SQL, 'insights_inventory_exceptions'));
  assert.match(statement, /p\.status = 'active'/);
  assert.match(statement, /p_max_cover_days numeric/);
  assert.match(statement, /m\.cover <= p_max_cover_days/);
  // "Low" and "critical" are words the service owns, never SQL.
  assert.doesNotMatch(statement, /'(critical|low|watch)'/i);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { RPC } from '../../scripts/lib/tables.mjs';
import { codeOnly, read } from './_shared.test.mjs';

const SQL = read('37_collection_handles');
const ANALYTICS = read('06_analytics');
const FUNCTION = 'insights_collection_sales';

/** One function's `create ... $$;` statement, verbatim. */
function statementOf(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  if (start < 0) return undefined;
  const end = sql.indexOf('\n$$;', start);
  return sql.slice(start, end + 4);
}

test('37 carries the collection function and nothing else', () => {
  const created = [...codeOnly(SQL).matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(created, [FUNCTION]);
});

test('37 copies the function from 06 rather than retyping it', () => {
  assert.ok(statementOf(SQL, FUNCTION));
  assert.equal(statementOf(SQL, FUNCTION), statementOf(ANALYTICS, FUNCTION));
});

test('the web reaches it through tables.mjs', () => {
  assert.equal(RPC.INSIGHTS_COLLECTION_SALES, FUNCTION);
});

test('it drops only the version it replaces, creates no table and writes no data', () => {
  const code = codeOnly(SQL);
  // 36's seven-argument version, by its exact signature: a bare `drop function`
  // by name would be ambiguous once two overloads exist.
  assert.match(code, /drop function if exists public\.insights_collection_sales\(uuid, timestamp, timestamp, text, text\[\], text\[\], integer\);/);
  assert.doesNotMatch(code, /create table/i);
  assert.doesNotMatch(code, /\b(insert|update|delete)\b/i);
});

test('it is granted like every other analytics function', () => {
  assert.match(SQL, new RegExp(`revoke all on function public\\.${FUNCTION} from public, anon, authenticated`));
  assert.match(SQL, new RegExp(`grant execute on function public\\.${FUNCTION} to service_role`));
  assert.match(SQL, new RegExp(`comment on function public\\.${FUNCTION} is`));
  const statement = statementOf(SQL, FUNCTION);
  assert.match(statement, /set search_path = public/);
  assert.match(statement, /\nstable\n/);
  assert.match(statement, /p_from timestamp,\n\s+p_to timestamp,\n\s+p_tz text/);
});

test('it counts lines exactly as the product ranking does', () => {
  const statement = codeOnly(statementOf(SQL, FUNCTION));
  const products = codeOnly(statementOf(ANALYTICS, 'insights_product_sales'));
  // A free line is a sample, not a sale — the same filter, in both.
  const paid = "coalesce((li.value ->> 'discounted_total')::numeric, 0) > 0";
  assert.ok(statement.includes(paid));
  assert.ok(products.includes(paid));
  for (const filter of ['o.deleted_at is null', 'o.cancelled_at is null', "li.value ->> 'product_id' is not null"]) {
    assert.ok(statement.includes(filter), filter);
  }
  assert.match(statement, /p_channels is null or o\.sales_channel_handle = any\(p_channels\)/);
});

test('only collections whose memberships are synced can be counted', () => {
  const statement = codeOnly(statementOf(SQL, FUNCTION));
  assert.match(statement, /from public\.advice_collections c/);
  assert.match(statement, /cardinality\(c\.product_ids\) > 0/);
  assert.match(statement, /c\.deleted_at is null/);
});

test('what belongs to no synced collection always comes back, as its own row', () => {
  // The card has to be able to say what it misses; without this row the
  // collections would read as the whole catalogue.
  const statement = codeOnly(statementOf(SQL, FUNCTION));
  assert.match(statement, /null::text as collection_id/);
  assert.match(statement, /where not exists \(select 1 from known k where l\.product_id = any\(k\.product_ids\)\)/);
  assert.match(statement, /union all\n\s+select \* from uncollected/);
});

test('a product counts in every collection that carries it, and the comment says so', () => {
  // The join is deliberately one-to-many: overlapping shares are the truth here,
  // and the caller is told not to sum them.
  const statement = codeOnly(statementOf(SQL, FUNCTION));
  assert.match(statement, /join ranged_lines l on l\.product_id = any\(k\.product_ids\)/);
  assert.match(SQL, /COLLECTIONS OVERLAP, AND THAT IS NOT A BUG/);
  assert.match(SQL, /never sum to the range|do not sum to the range/);
});

test("the handles filter is optional, and which handles is not SQL's business", () => {
  const statement = codeOnly(statementOf(SQL, FUNCTION));
  assert.match(statement, /p_handles text\[\] default null/);
  assert.match(statement, /p_handles is null or c\.handle = any\(p_handles\)/);
  // The six ranges live in scripts/lib/sales-collections.mjs, never here.
  assert.doesNotMatch(statement, /rituel-spa|temps-sublime|source-deau/);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { checkClause, codeOnly, columnsIn, literalsIn, read } from './_shared.test.mjs';

const SQL = read('27_advice_collections');
const SHOPIFY = read('02_shopify');
const TABLE = 'advice_collections';

/** One table's `create table ... );` statement, verbatim. */
function statementOf(sql) {
  const start = sql.indexOf(`create table public.${TABLE} (`);
  if (start < 0) return undefined;
  return sql.slice(start, sql.indexOf('\n);', start) + 3);
}

test('27 carries the one table and nothing else', () => {
  const created = [...codeOnly(SQL).matchAll(/create table public\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(created, [TABLE]);
});

test('27 copies the table from 02 rather than retyping it', () => {
  assert.ok(statementOf(SQL));
  assert.equal(statementOf(SQL), statementOf(SHOPIFY));
});

test('it alters nothing and writes no data', () => {
  const code = codeOnly(SQL);
  // Statement-leading, as the baseline invariant tests it: `before update on`
  // in the trigger is not a data statement, and a bare word test calls it one.
  for (const line of code.split('\n')) {
    assert.doesNotMatch(line, /^\s*(insert|update|delete)\s+/i, line);
  }
});

test('it brings its RLS, its trigger, its indexes and its comments with it', () => {
  // A table created by an incremental file and left without these is readable by
  // any anon key that reaches the project — the one thing the baseline's own
  // invariants exist to prevent, and they do not run over this file.
  assert.match(SQL, new RegExp(`alter table public\\.${TABLE} enable row level security`));
  assert.match(SQL, new RegExp(`create trigger ${TABLE}_set_updated_at`));
  assert.match(SQL, new RegExp(`comment on table public\\.${TABLE} is`));
  assert.match(SQL, /create index advice_collections_active_idx/);
  assert.match(SQL, /create index advice_collections_product_ids_gin_idx/);
});

test('the three local columns are documented as the sync-proof ones', () => {
  // `is_active`, `axis` and `note` survive a sync by not being in the mapper,
  // exactly as promotions.offerable_in_replies and recommended_for_concerns do.
  // The comment is the only place that says so, so it is asserted.
  for (const column of ['is_active', 'axis', 'note']) {
    assert.match(
      SQL,
      new RegExp(`comment on column public\\.${TABLE}\\.${column} is\\s+'Local`),
      `${column} is not documented as local`
    );
  }
});

test('membership is a list of Shopify ids, and liveness is not frozen into it', () => {
  // `product_ids` holds GIDs that join to products.shopify_product_id. Storing a
  // product's status here would go stale the moment somebody archives one, and a
  // recommendation is the last place that may happen.
  assert.ok(columnsIn(SQL, TABLE).includes('product_ids'));
  assert.match(
    SQL,
    /comment on column public\.advice_collections\.product_ids is[\s\S]*?liveness is decided against products\.status at read time, never frozen here/
  );
});

test('an axis is concern or category, or undecided', () => {
  const clause = checkClause(SQL, 'advice_collections_axis_check');
  assert.ok(clause, 'no axis constraint');
  assert.deepEqual(literalsIn(clause), ['category', 'concern']);
});

test('nothing is active until somebody switches it on', () => {
  // 175 collections exist, most of them seasonal merchandising or the output of
  // a diagnostic quiz. Defaulting to active would put Black Friday in front of a
  // customer asking about wrinkles.
  assert.match(statementOf(SQL), /is_active boolean not null default false/);
  assert.match(statementOf(SQL), /product_ids text\[\] not null default '\{\}'/);
});

test('one row per collection per shop', () => {
  assert.match(
    statementOf(SQL),
    /constraint advice_collections_shopify_unique unique \(shop_id, shopify_collection_id\)/
  );
});

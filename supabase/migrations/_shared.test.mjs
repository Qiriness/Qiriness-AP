import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { COLUMNS, PROJECTION_SOURCE, RPC, T, V, VECTOR_COLUMNS } from '../../scripts/lib/tables.mjs';

/**
 * Invariants that hold across the whole baseline.
 *
 * These live in one file rather than being repeated per migration because they
 * are properties of the SET of files, not of any one of them — "every table has
 * RLS" is only checkable once you have read all four, and "nothing is created
 * after it is referenced" is precisely a cross-file claim.
 */

export const FILES = [
  '01_foundation',
  '02_shopify',
  '03_knowledge',
  '04_support',
  '05_exemplars',
  '06_analytics',
  '07_drafting',
  '08_testing',
  '09_parameters'
];

/**
 * Incremental migrations, which are NOT part of the baseline and deliberately
 * not in `FILES`.
 *
 * The baseline invariants above are that these files create schema and never
 * migrate data, and that each states its final shape with no corrective
 * re-work — both true of 01-09 and both false of anything that ALTERs a live
 * database into a new state. A fresh install applies the baseline and gets the
 * end state directly; an existing database applies these on top.
 *
 * Each is written to be idempotent, so applying one to a fresh baseline is a
 * no-op rather than an error. They are tested by their own files.
 */
export const INCREMENTAL_FILES = [
  '10_order_retention',
  '11_insights_ranges',
  '12_vip_rule',
  '14_fulfilment_waiting',
  '15_orders_list',
  '16_orders_search',
  '17_management_chat',
  '18_product_customer_mix',
  '19_product_mix_filters',
  '20_best_products_vip',
  '21_chat_vip',
  '22_segment_finder',
  '23_agent_situations',
  '24_rule_tones',
  '25_rule_links',
  '26_product_order_frequency',
  '27_advice_collections',
  '30_customer_mix_plan',
  '31_orders_status_filter',
  '32_investigation_recommendations',
  '33_delivery_delay_need',
  '35_sales_overview'
];

export const read = (name) => readFileSync(new URL(`./${name}.sql`, import.meta.url), 'utf8');

/** All five files concatenated, in apply order. */
export const ALL = FILES.map(read).join('\n');

/** Strip -- comments so an assertion cannot be satisfied by prose. */
export const codeOnly = (sql) =>
  sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

export function tablesIn(sql) {
  return [...sql.matchAll(/create table public\.(\w+)/g)].map((m) => m[1]);
}

export function viewsIn(sql) {
  return [...sql.matchAll(/create view public\.(\w+)/g)].map((m) => m[1]);
}

export function functionsIn(sql) {
  return [...sql.matchAll(/create (?:or replace )?function public\.(\w+)/g)].map((m) => m[1]);
}

/**
 * The body of one `create table` or `create view`, without its comments.
 *
 * Cut at the first `;`, which terminates the statement in both cases: a column
 * list contains none, and neither does any view in the baseline. Comments are
 * stripped first so a semicolon written in prose cannot end the definition
 * early.
 */
export function definitionOf(sql, name) {
  // `if not exists` is optional here and cannot appear in the baseline — the
  // test below forbids it there. An INCREMENTAL migration must use it to be
  // idempotent, and comparing its table against the baseline's is how the two
  // are kept from drifting, so this parser has to read both.
  const start = sql.search(new RegExp(`create (?:table|view) (?:if not exists )?public\\.${name}\\b`));
  if (start < 0) return undefined;
  return codeOnly(sql.slice(start)).split(';')[0];
}

/**
 * The column names a `create table` declares.
 *
 * Table-level constraints sit at the same indent as columns, so they are
 * filtered by keyword rather than by layout — a `constraint` line would
 * otherwise read as a column called "constraint" and quietly satisfy any
 * projection assertion that mentioned one.
 */
const NOT_A_COLUMN = /^(constraint|primary|unique|check|foreign|exclude)$/i;

export function columnsIn(sql, relation) {
  const body = definitionOf(sql, relation);
  if (body === undefined) return [];
  return /^create view/i.test(body.trim()) ? viewColumns(body) : tableColumns(body);
}

function tableColumns(body) {
  return body
    .split('\n')
    .slice(1)
    .map((line) => line.match(/^\s{2}(\w+)\s+\S/))
    .filter(Boolean)
    .map((m) => m[1])
    .filter((name) => !NOT_A_COLUMN.test(name));
}

/**
 * The output column names of a view.
 *
 * Reads the select list — between `select` and the `from` that ends it — rather
 * than the source columns, because that is what a caller can actually ask
 * PostgREST for. Every projected column in the baseline's views carries an
 * explicit `as`, which is a house rule this parser depends on and the test below
 * enforces: an unaliased expression would have a name Postgres invents.
 */
function viewColumns(body) {
  const afterSelect = body.slice(body.search(/\bselect\b/i)).replace(/^select\s+/i, '');
  const withoutDistinct = afterSelect.replace(/^distinct on \([^)]*\)/i, '');
  const end = withoutDistinct.search(/^\s*from\s/im);
  const list = end < 0 ? withoutDistinct : withoutDistinct.slice(0, end);

  return splitTopLevel(list)
    .map((item) => item.match(/\bas\s+(\w+)\s*$/i))
    .filter(Boolean)
    .map((m) => m[1]);
}

/** Split a select list on commas that are not inside parentheses. */
function splitTopLevel(list) {
  const items = [];
  let depth = 0;
  let current = '';
  for (const char of list) {
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      items.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

/**
 * The body of a named CHECK constraint.
 *
 * Balances parentheses rather than matching to a fixed indent: these clauses are
 * written inline, as table constraints and at two nesting depths, and a regex
 * pinned to one layout silently returns undefined for the others.
 */
export function checkClause(sql, name) {
  const start = sql.search(new RegExp(`constraint ${name} check\\s*\\(`, 'i'));
  if (start < 0) return undefined;
  const open = sql.indexOf('(', start);
  let depth = 0;
  for (let i = open; i < sql.length; i += 1) {
    if (sql[i] === '(') depth += 1;
    else if (sql[i] === ')') {
      depth -= 1;
      if (depth === 0) return sql.slice(open + 1, i);
    }
  }
  return undefined;
}

/**
 * The body of an ANONYMOUS check written inline on a column, e.g.
 * `verdict text not null check (...)`. Named and inline checks are both used in
 * the baseline and neither form is wrong, so the tests can read either.
 */
export function columnCheck(sql, column) {
  const start = sql.search(new RegExp(`^\\s*${column}\\s+\\w+[^\\n]*check\\s*\\(`, 'im'));
  if (start < 0) return undefined;
  const open = sql.indexOf('check', start) + 'check'.length;
  const from = sql.indexOf('(', open);
  let depth = 0;
  for (let i = from; i < sql.length; i += 1) {
    if (sql[i] === '(') depth += 1;
    else if (sql[i] === ')') {
      depth -= 1;
      if (depth === 0) return sql.slice(from + 1, i);
    }
  }
  return undefined;
}

/**
 * The quoted string literals inside a clause, sorted.
 *
 * `[^']+` rather than `[a-z_]+`: several taxonomy values carry a digit (`b2b`),
 * and a letters-only pattern silently drops them, which reads as the constraint
 * being wrong rather than the test.
 */
export const literalsIn = (clause) =>
  [...clause.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();

test('the baseline creates schema, never migrates data', () => {
  // A baseline runs against an EMPTY database, so a data statement in one is
  // either dead or a sign the file has drifted back into being a patch.
  for (const line of codeOnly(ALL).split('\n')) {
    assert.doesNotMatch(line, /^\s*(update|insert|delete)\s+/i, line);
  }
});

test('the baseline states the final shape, with no corrective re-work', () => {
  // The whole point of the reorganisation: a table is created complete. An
  // `alter table ... add column` here means a file is describing history again.
  assert.doesNotMatch(codeOnly(ALL), /alter table public\.\w+\s+add column/i);
  assert.doesNotMatch(codeOnly(ALL), /alter table public\.\w+\s+add constraint/i);
  assert.doesNotMatch(codeOnly(ALL), /drop (table|column|constraint)/i);
});

test('nothing is guarded with IF NOT EXISTS except the extensions', () => {
  // Deliberately not idempotent: guarding every statement would obscure the
  // schema these files exist to document. Extensions are the exception because
  // a Supabase project ships with them already installed.
  const guarded = [...codeOnly(ALL).matchAll(/^create (\w+) if not exists/gim)].map((m) => m[1]);
  assert.deepEqual([...new Set(guarded)].sort(), ['extension']);
});

test('every table it creates has RLS enabled', () => {
  // Service-role only until dashboard roles exist. A table without this is
  // readable by any anon key that reaches the project.
  for (const table of tablesIn(ALL)) {
    assert.match(
      ALL,
      new RegExp(`alter table public\\.${table} enable row level security`, 'i'),
      `${table} is missing RLS`
    );
  }
});

test('every table it creates is documented', () => {
  for (const table of tablesIn(ALL)) {
    assert.match(ALL, new RegExp(`comment on table public\\.${table} is`, 'i'), `${table} has no comment`);
  }
});

test('every table carrying updated_at maintains it with the shared trigger', () => {
  for (const file of FILES) {
    const sql = read(file);
    for (const block of sql.split(/create table public\./).slice(1)) {
      const table = block.match(/^(\w+)/)[1];
      const body = block.split(/\n\);/)[0];
      if (!/^\s*updated_at timestamptz/m.test(body)) continue;
      assert.match(
        ALL,
        new RegExp(`create trigger ${table}_set_updated_at[\\s\\S]*?on public\\.${table}`, 'i'),
        `${table} has updated_at but no trigger`
      );
    }
  }
});

test('nothing references a table before it is created', () => {
  // The apply order is a plain dependency chain, and this is what proves it:
  // running the files in order against an empty database cannot hit a missing
  // FK target. Verified for real by applying both this baseline and the eight
  // files it replaces into throwaway schemas and diffing the result.
  const created = new Set();
  const ordered = FILES.map(read).join('\n');
  const statements = ordered.split(';');

  for (const statement of statements) {
    const code = codeOnly(statement);
    const create = code.match(/create table public\.(\w+)/);

    for (const ref of code.matchAll(/references public\.(\w+)/g)) {
      // A table may reference itself; everything else must already exist.
      if (create && ref[1] === create[1]) continue;
      assert.ok(
        created.has(ref[1]),
        `references public.${ref[1]} before it is created` + (create ? ` (in ${create[1]})` : '')
      );
    }
    if (create) created.add(create[1]);
  }
});

test('every name in the schema contract is created by the baseline', () => {
  // `scripts/lib/tables.mjs` is what the three packages import instead of
  // quoting table names. This is the assertion that makes it a contract rather
  // than a second place to be wrong: a table renamed in the DDL and not in the
  // module (or the reverse) fails here, at `npm test`, instead of failing in
  // PostgREST on whichever code path happened to ask first.
  const tables = new Set(tablesIn(ALL));
  for (const [key, name] of Object.entries(T)) {
    assert.ok(tables.has(name), `T.${key} names ${name}, which the baseline does not create`);
  }
  assert.equal(
    Object.keys(T).length,
    tables.size,
    'the baseline creates a table the contract does not name'
  );

  const views = new Set(viewsIn(ALL));
  for (const [key, name] of Object.entries(V)) {
    assert.ok(views.has(name), `V.${key} names ${name}, which the baseline does not create`);
  }
  assert.equal(Object.keys(V).length, views.size, 'the baseline creates a view the contract does not name');

  const functions = new Set(functionsIn(ALL));
  for (const [key, name] of Object.entries(RPC)) {
    assert.ok(functions.has(name), `RPC.${key} names ${name}, which the baseline does not create`);
  }
});

test('every column in the schema contract exists on the relation it projects', () => {
  // The other half of the drift. A projection is a comma-separated select list,
  // so a column dropped from the DDL leaves a string that PostgREST rejects at
  // runtime — on one reader, whenever that reader next runs.
  for (const [name, projection] of Object.entries(COLUMNS)) {
    const source = PROJECTION_SOURCE[name];
    assert.ok(source, `COLUMNS.${name} has no entry in PROJECTION_SOURCE`);

    // PostgREST embeds are written `customers(a,b)` and resolve over a foreign
    // key rather than naming a column on this relation; strip them before
    // splitting, and assert the embedded columns against the embedded table.
    const embeds = [...projection.matchAll(/(\w+)\(([^)]*)\)/g)];
    const own = projection.replace(/\w+\([^)]*\)/g, '').split(',').filter(Boolean);

    const available = new Set(columnsIn(ALL, source));
    assert.ok(available.size > 0, `${source} has no readable column list`);
    for (const column of own) {
      assert.ok(available.has(column), `COLUMNS.${name} reads ${source}.${column}, which does not exist`);
    }

    for (const [, table, columns] of embeds) {
      const embedded = new Set(columnsIn(ALL, table));
      for (const column of columns.split(',').filter(Boolean)) {
        assert.ok(embedded.has(column), `COLUMNS.${name} embeds ${table}.${column}, which does not exist`);
      }
    }
  }
});

test('every view reads with the caller\'s row-level security, not its owner\'s', () => {
  // THE ONE THING A VIEW CAN GET CATASTROPHICALLY WRONG HERE. A view without
  // `security_invoker` executes as its owner and reads straight past the RLS on
  // the tables underneath. Every table in this baseline has RLS enabled with no
  // policies so that only the service role can read it, which makes an
  // owner-rights view over `tickets` the single way an anon key could read the
  // whole support mailbox.
  for (const view of viewsIn(ALL)) {
    const definition = definitionOf(ALL, view);
    assert.match(
      definition,
      /with \(security_invoker = true\)/i,
      `${view} does not set security_invoker`
    );
    assert.match(
      ALL,
      new RegExp(`revoke all on public\\.${view} from anon, authenticated`, 'i'),
      `${view} is not revoked from the anon roles`
    );
  }
});

test('every view names its output columns explicitly', () => {
  // Not style. An unaliased expression -- `coalesce(n.message_count, 0)` -- gets
  // whatever name Postgres invents for it, and a caller asking PostgREST for it
  // by the name it expected gets a 400. Aliasing every item makes the view's
  // interface the thing written in the file.
  for (const view of viewsIn(ALL)) {
    const definition = definitionOf(ALL, view);
    const afterSelect = definition.slice(definition.search(/\bselect\b/i)).replace(/^select\s+/i, '');
    const withoutDistinct = afterSelect.replace(/^distinct on \([^)]*\)/i, '');
    const end = withoutDistinct.search(/^\s*from\s/im);
    const list = end < 0 ? withoutDistinct : withoutDistinct.slice(0, end);

    for (const item of splitTopLevel(list)) {
      assert.match(item, /\bas\s+\w+\s*$/i, `${view} projects ${item.trim()} without an alias`);
    }
  }
});

test('every view it creates is documented', () => {
  for (const view of viewsIn(ALL)) {
    assert.match(ALL, new RegExp(`comment on view public\\.${view} is`, 'i'), `${view} has no comment`);
  }
});

test('every table holding a vector carries the whole determinism quadruple', () => {
  // knowledge_chunks, ticket_messages and support_exemplar_phrasings each hold
  // an embedding, and each decides staleness the same way: the stored model,
  // dimensions and input hash against the current ones. The pattern was copied
  // by hand three times — this is what stops a fourth table copying three of the
  // four columns and silently never going stale.
  for (const table of tablesIn(ALL)) {
    const columns = columnsIn(ALL, table);
    if (!columns.includes('embedding')) continue;
    for (const column of VECTOR_COLUMNS) {
      assert.ok(columns.includes(column), `${table} holds an embedding but no ${column}`);
    }
  }
});

test('every table holding a vector constrains its dimensions the same way', () => {
  // The half of the pattern that DID drift: ticket_messages copied the four
  // columns from knowledge_chunks and not the check, so it would have accepted a
  // 3072-dimension vector written by a model change nobody finished — a row that
  // then never goes stale, because the stored dimensions match what was stored.
  //
  // Asserted on the clause rather than on the constraint's presence, so a table
  // cannot satisfy this with a check that permits something else.
  for (const table of tablesIn(ALL)) {
    if (!columnsIn(ALL, table).includes('embedding')) continue;

    const clause = checkClause(ALL, `${table}_embedding_dimensions_check`);
    assert.ok(clause, `${table} holds an embedding but does not constrain embedding_dimensions`);
    assert.equal(
      clause.replace(/\s+/g, ' ').trim(),
      'embedding_dimensions is null or embedding_dimensions = 1536',
      `${table} constrains embedding_dimensions differently from the other embedded tables`
    );
  }
});

test('the nine files are the whole baseline, in this order', () => {
  // README and APP_SCHEMA both name these; a file appearing without those being
  // updated is the drift this catches.
  assert.deepEqual(FILES, [
    '01_foundation',
    '02_shopify',
    '03_knowledge',
    '04_support',
    '05_exemplars',
    '06_analytics',
    '07_drafting',
    '08_testing',
    '09_parameters'
  ]);
});

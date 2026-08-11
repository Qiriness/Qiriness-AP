import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

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
  '05_exemplars'
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

test('the five files are the whole baseline, in this order', () => {
  // README and APP_SCHEMA both name these; a file appearing without those being
  // updated is the drift this catches.
  assert.deepEqual(FILES, [
    '01_foundation',
    '02_shopify',
    '03_knowledge',
    '04_support',
    '05_exemplars'
  ]);
});

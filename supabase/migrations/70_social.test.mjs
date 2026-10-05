import assert from 'node:assert/strict';
import test from 'node:test';

import { MAIL_JOB_KINDS } from '../../scripts/lib/mail-job-record.mjs';
import { AD_PUBLISHERS, AUDIENCE_DIMENSIONS, SOCIAL_KINDS, SOCIAL_PROVIDERS } from '../../scripts/lib/social-model.mjs';
import { SOCIAL_RPC, SOCIAL_T } from '../../scripts/lib/tables.mjs';
import { checkClause, codeOnly, literalsIn, read } from './_shared.test.mjs';

const SQL = read('70_social');
const CODE = codeOnly(SQL);
const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/** One function's `create ... $$;` statement, verbatim. */
function statementOf(name) {
  const start = CODE.indexOf(`create or replace function public.${name}(`);
  if (start < 0) return undefined;
  return CODE.slice(start, CODE.indexOf('\n$$;', start) + 4);
}

const KEY_FUNCTIONS = [SOCIAL_RPC.SAVE_TOKEN, SOCIAL_RPC.READ_TOKEN, SOCIAL_RPC.CLEAR_TOKEN];
const READS = Object.values(SOCIAL_RPC).filter((name) => !KEY_FUNCTIONS.includes(name));

test('70 creates exactly the social tables and functions, named as tables.mjs names them', () => {
  const tables = [...CODE.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(tables, Object.values(SOCIAL_T));
  const functions = [...CODE.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(functions, Object.values(SOCIAL_RPC));
});

test('every table is closed to anon and authenticated, and documented', () => {
  for (const table of Object.values(SOCIAL_T)) {
    assert.match(CODE, new RegExp(`alter table public\\.${table} enable row level security;`), table);
    assert.match(CODE, new RegExp(`revoke all on public\\.${table} from anon, authenticated;`), table);
    assert.match(CODE, new RegExp(`comment on table public\\.${table} is`), table);
  }
});

test('the token is never a column: the connection stores a Vault id', () => {
  const connection = CODE.slice(CODE.indexOf('create table if not exists public.social_connections'));
  const columns = connection.slice(0, connection.indexOf(');\n'));
  assert.match(columns, /secret_id uuid not null/);
  assert.doesNotMatch(columns, /\b(token|access_token|refresh_token|secret)\s+text\b/);
});

test('the token functions are security definer, pinned, and callable by the service role only', () => {
  for (const name of KEY_FUNCTIONS) {
    const statement = statementOf(name);
    assert.ok(statement, name);
    assert.match(statement, /security definer/, name);
    assert.match(statement, /set search_path = ''/, name);
    assert.match(CODE, new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon, authenticated;`), name);
    assert.match(CODE, new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to service_role;`), name);
  }
});

test('the reads are security invoker, service role only, and skip disabled accounts', () => {
  for (const name of READS) {
    const statement = statementOf(name);
    assert.ok(statement, name);
    assert.match(statement, /security invoker/, name);
    assert.match(statement, /\ba\.enabled\b/, name);
    assert.match(CODE, new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon, authenticated;`), name);
    assert.match(CODE, new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to service_role;`), name);
  }
});

test('the ranged reads take wall-clock timestamps, never timestamptz arguments', () => {
  for (const name of READS) {
    const signature = statementOf(name).slice(0, statementOf(name).indexOf(')\nreturns'));
    assert.doesNotMatch(signature, /timestamptz/, name);
  }
  const posts = statementOf(SOCIAL_RPC.POSTS);
  assert.match(posts, /p\.published_at >= \(p_from at time zone p_tz\)/);
  assert.match(posts, /p\.published_at < \(p_to at time zone p_tz\)/);
});

test('no rate is stored, and unique-audience counts are not stored per day', () => {
  for (const column of ['engagement_rate', 'ctr', 'cpc', 'cpa', 'roas']) {
    assert.doesNotMatch(CODE, new RegExp(`\\b${column}\\b`), column);
  }
  const days = CODE.slice(CODE.indexOf('create table if not exists public.social_account_days'));
  const columns = days.slice(0, days.indexOf(');\n'));
  assert.doesNotMatch(columns, /\breach\b|\baccounts_engaged\b/);
});

test('the checks list exactly what social-model.mjs knows', () => {
  assert.deepEqual(literalsIn(checkClause(SQL, 'social_connections_provider_check')), [...SOCIAL_PROVIDERS].sort());
  assert.deepEqual(literalsIn(checkClause(SQL, 'social_accounts_provider_check')), [...SOCIAL_PROVIDERS].sort());
  assert.deepEqual(literalsIn(checkClause(SQL, 'social_accounts_kind_check')), [...SOCIAL_KINDS].sort());
  assert.deepEqual(literalsIn(checkClause(SQL, 'ad_days_publisher_check')), [...AD_PUBLISHERS].sort());
  assert.deepEqual(literalsIn(checkClause(SQL, 'social_audience_dimension_check')), [...AUDIENCE_DIMENSIONS].sort());
});

test('the widened job kind is the baseline clause, word for word, and the record module agrees', () => {
  const clause = squash(checkClause(SQL, 'mail_jobs_kind_check'));
  assert.equal(clause, squash(checkClause(read('04_support'), 'mail_jobs_kind_check')));
  assert.equal(clause, squash(checkClause(read('46_mail_jobs'), 'mail_jobs_kind_check')));
  assert.deepEqual(literalsIn(checkClause(SQL, 'mail_jobs_kind_check')), [...MAIL_JOB_KINDS].sort());
  assert.match(CODE, /drop constraint if exists mail_jobs_kind_check;/);
});

test('it writes no data', () => {
  const outside = CODE.replace(/create or replace function[\s\S]*?\n\$\$;/g, '');
  assert.doesNotMatch(outside, /\binsert into\b|\bupdate public\.|\bdelete from\b/i);
});

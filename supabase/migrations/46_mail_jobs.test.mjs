import assert from 'node:assert/strict';
import test from 'node:test';

import { MAIL_JOB_KINDS, MAIL_JOB_STATES } from '../../scripts/lib/mail-job-record.mjs';
import { checkClause, codeOnly, columnsIn, literalsIn, read } from './_shared.test.mjs';

const SQL = read('46_mail_jobs');
const SUPPORT = read('04_support');

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const functionBody = (sql, name) =>
  squash(codeOnly(sql).match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\$\\$;`))?.[0]);

test('46 creates the same two tables the baseline does, column for column', () => {
  for (const table of ['mail_jobs', 'mail_subscriptions']) {
    assert.ok(columnsIn(SUPPORT, table).length > 0, `${table} is missing from 04`);
    assert.deepEqual(columnsIn(SQL, table), columnsIn(SUPPORT, table), table);
  }
});

test('46 carries the baseline checks, not retyped ones', () => {
  for (const name of [
    'mail_jobs_kind_check',
    'mail_jobs_state_check',
    'mail_jobs_retry_count_check',
    'mail_jobs_payload_check',
    'mail_subscriptions_provider_check',
    'mail_subscriptions_folder_check'
  ]) {
    assert.ok(checkClause(SQL, name), `${name} is missing from 46`);
    assert.equal(squash(checkClause(SQL, name)), squash(checkClause(SUPPORT, name)), name);
  }
});

test('the job kinds and states are the ones the record module knows', () => {
  assert.deepEqual(literalsIn(checkClause(SUPPORT, 'mail_jobs_kind_check')), [...MAIL_JOB_KINDS].sort());
  assert.deepEqual(literalsIn(checkClause(SUPPORT, 'mail_jobs_state_check')), [...MAIL_JOB_STATES].sort());
});

test('the two functions are copied, not retyped', () => {
  for (const name of ['enqueue_mail_job', 'claim_mail_jobs']) {
    assert.ok(functionBody(SUPPORT, name), `${name} is missing from 04`);
    assert.equal(functionBody(SQL, name), functionBody(SUPPORT, name), name);
  }
});

test('dedupe applies to queued jobs only, so a running sync never swallows a newer request', () => {
  assert.match(SUPPORT, /create unique index mail_jobs_queued_dedupe_idx\s+on public\.mail_jobs \(shop_id, dedupe_key\)\s+where state = 'queued';/);
  assert.match(functionBody(SUPPORT, 'enqueue_mail_job'), /on conflict \(shop_id, dedupe_key\) where state = 'queued'/);
});

test('claiming skips locked rows and takes back a job whose lease ran out, counting it', () => {
  const claim = functionBody(SUPPORT, 'claim_mail_jobs');
  assert.match(claim, /for update skip locked/);
  assert.match(claim, /c\.state = 'running' and c\.locked_until < now\(\)/);
  assert.match(claim, /retry_count = j\.retry_count \+ case when j\.state = 'running' then 1 else 0 end/);
});

test('one subscription per shop, provider and folder, and the client state is only a hash', () => {
  assert.match(SUPPORT, /constraint mail_subscriptions_shop_folder_key unique \(shop_id, provider, folder\)/);
  const columns = columnsIn(SUPPORT, 'mail_subscriptions');
  assert.ok(columns.includes('client_state_hash'));
  assert.ok(!columns.includes('client_state'));
});

test('46 is idempotent and writes no data', () => {
  const code = codeOnly(SQL);
  assert.match(code, /create table if not exists public\.mail_jobs/);
  assert.match(code, /create table if not exists public\.mail_subscriptions/);
  assert.match(code, /drop trigger if exists mail_jobs_set_updated_at on public\.mail_jobs;/);
  for (const line of code.split('\n')) {
    assert.doesNotMatch(line, /^\s*(insert|update|delete)\s+/i, line);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  backoffMs,
  createMailJobRecord,
  failurePatch,
  sendDedupeKey,
  syncDedupeKey
} from './mail-job-record.mjs';
import { RPC, T } from './tables.mjs';

function recorder({ rpcRows = [], selectRows = [] } = {}) {
  const calls = [];
  return {
    calls,
    transport: {
      async rpc(_client, fn, args) {
        calls.push({ kind: 'rpc', fn, args });
        return rpcRows;
      },
      async select(_client, table, filters, columns, options) {
        calls.push({ kind: 'select', table, filters, columns, options });
        return selectRows;
      },
      async update(_client, table, filters, patch) {
        calls.push({ kind: 'update', table, filters, patch });
        return [{ id: 'x' }];
      }
    }
  };
}

const jobsWith = (options) => {
  const rec = recorder(options);
  return { rec, jobs: createMailJobRecord({}, { shopId: 'shop-1', transport: rec.transport }) };
};

test('backoff doubles from 30 s, is capped at an hour, and jitters within ±20 %', () => {
  const exact = { random: () => 0.5 };
  assert.equal(backoffMs(0, exact), 30_000);
  assert.equal(backoffMs(1, exact), 60_000);
  assert.equal(backoffMs(3, exact), 240_000);
  assert.equal(backoffMs(20, exact), 3_600_000);
  assert.equal(backoffMs(0, { random: () => 0 }), 24_000);
  assert.equal(backoffMs(0, { random: () => 1 }), 36_000);
});

test('a failure requeues with backoff until the cap, then the job is dead', () => {
  const now = new Date('2026-09-28T10:00:00Z');
  const retry = failurePatch({ retry_count: 0 }, new Error('Graph send failed: HTTP 503'), { maxAttempts: 3, now, random: () => 0.5 });
  assert.equal(retry.state, 'queued');
  assert.equal(retry.retry_count, 1);
  assert.equal(retry.last_error, 'Graph send failed: HTTP 503');
  assert.equal(retry.next_attempt_at, '2026-09-28T10:00:30.000Z');

  const dead = failurePatch({ retry_count: 2 }, 'still failing', { maxAttempts: 3, now });
  assert.equal(dead.state, 'dead');
  assert.equal(dead.retry_count, 3);
  assert.equal('next_attempt_at' in dead, false);
});

test('an error is kept to one bounded line', () => {
  const patch = failurePatch({ retry_count: 0 }, new Error(`line one\n  line two ${'x'.repeat(600)}`));
  assert.doesNotMatch(patch.last_error, /\n/);
  assert.ok(patch.last_error.length <= 500);
});

test('dedupe keys: one per folder, one per outbound action', () => {
  assert.equal(syncDedupeKey('inbox'), 'sync:inbox');
  assert.equal(sendDedupeKey('a1'), 'send:a1');
});

test('enqueue goes through the function that collapses into a queued job', async () => {
  const { rec, jobs } = jobsWith({ rpcRows: [{ id: 'j1' }] });
  const row = await jobs.enqueue({ kind: 'sync_mailbox', dedupeKey: 'sync:inbox', payload: { folder: 'inbox' } });
  assert.deepEqual(row, { id: 'j1' });
  assert.equal(rec.calls[0].fn, RPC.ENQUEUE_MAIL_JOB);
  assert.equal(rec.calls[0].args.p_shop_id, 'shop-1');
  assert.equal(rec.calls[0].args.p_dedupe_key, 'sync:inbox');
  assert.deepEqual(rec.calls[0].args.p_payload, { folder: 'inbox' });
});

test('enqueue refuses an unknown kind or a missing key', async () => {
  const { jobs } = jobsWith();
  await assert.rejects(jobs.enqueue({ kind: 'process_message', dedupeKey: 'x' }), /sync_mailbox, send_outbound/);
  await assert.rejects(jobs.enqueue({ kind: 'sync_mailbox' }), /dedupeKey/);
});

test('claim passes the kinds, the limit and the lease to the claiming function', async () => {
  const { rec, jobs } = jobsWith({ rpcRows: [{ id: 'j1' }] });
  const claimed = await jobs.claim({ kinds: ['send_outbound'], limit: 3, leaseSeconds: 120 });
  assert.deepEqual(claimed, [{ id: 'j1' }]);
  assert.equal(rec.calls[0].fn, RPC.CLAIM_MAIL_JOBS);
  assert.deepEqual(rec.calls[0].args, { p_shop_id: 'shop-1', p_kinds: ['send_outbound'], p_limit: 3, p_lease_seconds: 120 });
});

test('complete and fail only touch a job still running, so a reclaimed job is not closed under its new holder', async () => {
  const { rec, jobs } = jobsWith();
  await jobs.complete('j1');
  await jobs.fail({ id: 'j2', retry_count: 0 }, new Error('boom'));
  for (const call of rec.calls) {
    assert.equal(call.table, T.MAIL_JOBS);
    assert.equal(call.filters.state, 'running');
    assert.equal(call.filters.shop_id, 'shop-1');
  }
  assert.equal(rec.calls[0].patch.state, 'done');
  assert.equal(rec.calls[1].patch.state, 'queued');
});

test('hasDue asks for queued jobs whose time has come', async () => {
  const { rec, jobs } = jobsWith({ selectRows: [{ id: 'j1' }] });
  const due = await jobs.hasDue({ kinds: ['sync_mailbox', 'send_outbound'], now: new Date('2026-09-28T10:00:00Z') });
  assert.equal(due, true);
  const { filters } = rec.calls[0];
  assert.equal(filters.state, 'queued');
  assert.deepEqual(filters.kind, { operator: 'in', value: '(sync_mailbox,send_outbound)' });
  assert.deepEqual(filters.next_attempt_at, { operator: 'lte', value: '2026-09-28T10:00:00.000Z' });
});

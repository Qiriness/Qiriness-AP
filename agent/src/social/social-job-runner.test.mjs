import assert from 'node:assert/strict';
import test from 'node:test';

import { runSocialJobs } from './social-job-runner.mjs';

function fakeJobs(claimed) {
  const done = [];
  const failed = [];
  return {
    done,
    failed,
    claim: async ({ kinds }) => {
      assert.deepEqual(kinds, ['sync_social']);
      return claimed;
    },
    complete: async (id) => done.push(id),
    fail: async (job, error) => {
      failed.push({ id: job.id, error: error.message });
      return { state: 'queued', last_error: error.message };
    }
  };
}

test('a synced provider closes its job; a refused token closes it too, since retrying cannot help', async () => {
  const jobs = fakeJobs([
    { id: 'j1', payload: { provider: 'meta' } },
    { id: 'j2', payload: { provider: 'google' } }
  ]);
  const totals = await runSocialJobs({
    jobs,
    supabase: {},
    shopId: 's',
    env: {},
    sync: async ({ provider }) => ({ [provider]: { status: provider === 'meta' ? 'ok' : 'needs_reconnect' } })
  });
  assert.deepEqual(jobs.done, ['j1', 'j2']);
  assert.equal(totals.ok, 1);
  assert.equal(totals.needs_reconnect, 1);
});

test('a failed sync is retried with its reason', async () => {
  const jobs = fakeJobs([{ id: 'j1', payload: { provider: 'meta' } }]);
  const totals = await runSocialJobs({
    jobs,
    supabase: {},
    shopId: 's',
    env: {},
    sync: async () => ({ meta: { status: 'failed', error: 'Page: rate limited' } })
  });
  assert.deepEqual(jobs.failed, [{ id: 'j1', error: 'Page: rate limited' }]);
  assert.equal(totals.retried, 1);
});

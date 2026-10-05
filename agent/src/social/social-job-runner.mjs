import { runSocialSync } from '../../../scripts/lib/social-sync.mjs';

/**
 * The `sync_social` jobs: a provider was just connected, or someone pressed
 * « Sync now ». The dashboard cannot run a backfill inside a request, so it
 * queues one and the worker — always running — carries it out between mail
 * polls. The nightly still runs the same sync; this is only the fast path.
 *
 * WHAT IS RETRIED. A provider whose sync `failed` (a rate limit, a 5xx, one
 * account erroring) is retried with backoff. A token the provider refused
 * (`needs_reconnect`) or a provider not connected / not configured (`skipped`)
 * is done: retrying cannot change the answer, and the connection row already
 * says what a person has to do.
 */
export async function runSocialJobs({
  jobs,
  supabase,
  shopId,
  env,
  maxAttempts,
  logger,
  limit = 4,
  leaseSeconds = 1800,
  sync = runSocialSync
}) {
  const totals = { considered: 0, ok: 0, skipped: 0, needs_reconnect: 0, retried: 0, dead: 0 };
  const claimed = await jobs.claim({ kinds: ['sync_social'], limit, leaseSeconds });

  for (const job of claimed) {
    totals.considered += 1;
    const provider = job.payload?.provider ?? null;
    try {
      const results = await sync({ supabase, shopRow: { id: shopId }, provider, env, log: (line) => logger?.info?.('social.sync_log', { shopId, line }) });
      const outcomes = provider ? [results[provider]] : Object.values(results);
      const failed = outcomes.find((r) => r?.status === 'failed');
      if (failed) throw new Error(failed.error ?? 'social sync failed');
      for (const r of outcomes) totals[r?.status === 'needs_reconnect' ? 'needs_reconnect' : r?.status === 'ok' ? 'ok' : 'skipped'] += 1;
      await jobs.complete(job.id);
      logger?.info?.('social.synced', { shopId, provider, results: summary(results) });
    } catch (error) {
      const patch = await jobs.fail(job, error, { maxAttempts });
      totals[patch.state === 'dead' ? 'dead' : 'retried'] += 1;
      logger?.warn?.('social.sync_failed', { shopId, provider, jobId: job.id, state: patch.state, error: patch.last_error });
    }
  }
  return totals;
}

function summary(results) {
  return Object.fromEntries(
    Object.entries(results).map(([provider, r]) => [provider, { status: r.status, accounts: r.accounts, days: r.days, posts: r.posts, ad_days: r.ad_days, campaign_days: r.campaign_days }])
  );
}

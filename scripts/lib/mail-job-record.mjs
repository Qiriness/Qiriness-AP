import { supabaseRpc, supabaseSelect, supabaseUpdate } from './supabase-rest-client.mjs';
import { RPC, T } from './tables.mjs';

/**
 * The `mail_jobs` queue, and the only module that writes it.
 *
 * Lives in scripts/lib, beside ticket-record and draft-record, for the same
 * reason they do: two runtimes enqueue (the dashboard approving a reply, the
 * webhook asking for a folder to be read) and one claims (the worker), and
 * `web/` cannot import from `agent/src`.
 *
 * WHAT A JOB IS FOR. Two kinds only (04_support.sql explains why case
 * processing is not one): `sync_mailbox`, a nudge to read a folder now, and
 * `send_outbound`, the attempts of one outbound action. The job carries the
 * attempts; the business state lives elsewhere (the cursor, the action row).
 *
 * RETRIES. `fail` counts the attempt and pushes the job out with backoff;
 * past `maxAttempts` it goes `dead` and stays, for a person to read. A worker
 * that died holding a job gets it back when the lease runs out, and the claim
 * counts that as an attempt too (claim_mail_jobs).
 */

/** Mirrors mail_jobs_kind_check; 46_mail_jobs.test.mjs asserts the two agree. */
export const MAIL_JOB_KINDS = ['sync_mailbox', 'send_outbound'];

/** Mirrors mail_jobs_state_check. */
export const MAIL_JOB_STATES = ['queued', 'running', 'done', 'dead'];

export const DEFAULT_MAX_ATTEMPTS = 5;

const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

/** One job per folder in the queue at a time. */
export function syncDedupeKey(folder) {
  return `sync:${folder}`;
}

/** One job per outbound action in the queue at a time. */
export function sendDedupeKey(outboundActionId) {
  return `send:${outboundActionId}`;
}

/**
 * How long to wait before attempt `retryCount + 1`: 30 s doubling, capped at
 * an hour, with ±20 % jitter so jobs that failed together do not retry
 * together. Pure; `random` is injectable for tests.
 */
export function backoffMs(retryCount, { baseMs = BASE_BACKOFF_MS, capMs = MAX_BACKOFF_MS, random = Math.random } = {}) {
  const exponent = Math.max(0, Number(retryCount) || 0);
  const raw = Math.min(capMs, baseMs * 2 ** Math.min(exponent, 30));
  const jitter = 0.8 + 0.4 * random();
  return Math.min(capMs, Math.round(raw * jitter));
}

/**
 * The row a failed attempt leaves. Pure, so "dead after the cap" is tested
 * without a database. `job.retry_count` is the count BEFORE this failure.
 */
export function failurePatch(job, error, { maxAttempts = DEFAULT_MAX_ATTEMPTS, now = new Date(), random } = {}) {
  const retryCount = (Number(job?.retry_count) || 0) + 1;
  const lastError = oneLine(error);
  if (retryCount >= maxAttempts) {
    return { state: 'dead', retry_count: retryCount, last_error: lastError, locked_until: null };
  }
  return {
    state: 'queued',
    retry_count: retryCount,
    last_error: lastError,
    locked_until: null,
    next_attempt_at: new Date(now.getTime() + backoffMs(retryCount - 1, { random })).toISOString()
  };
}

export const REST_TRANSPORT = {
  rpc: supabaseRpc,
  select: supabaseSelect,
  update: supabaseUpdate
};

export function createMailJobRecord(supabase, { shopId, transport = REST_TRANSPORT }) {
  if (!shopId) {
    throw new Error('createMailJobRecord requires a shopId: every read and write here is shop-scoped.');
  }
  const { rpc, select, update } = transport;

  return {
    /**
     * Queue a job, or bring forward the one already queued under the same key.
     * Returns the queued row.
     */
    async enqueue({ kind, dedupeKey, payload = {}, runAt = null }) {
      if (!MAIL_JOB_KINDS.includes(kind)) {
        throw new Error(`enqueue takes one of ${MAIL_JOB_KINDS.join(', ')}; got ${JSON.stringify(kind)}.`);
      }
      if (!dedupeKey) {
        throw new Error('enqueue requires a dedupeKey.');
      }
      const rows = await rpc(supabase, RPC.ENQUEUE_MAIL_JOB, {
        p_shop_id: shopId,
        p_kind: kind,
        p_dedupe_key: dedupeKey,
        p_payload: payload,
        p_run_at: runAt ?? new Date().toISOString()
      });
      return Array.isArray(rows) ? rows[0] ?? null : rows ?? null;
    },

    /** Take up to `limit` due jobs of these kinds, leased for `leaseSeconds`. */
    async claim({ kinds, limit = 10, leaseSeconds = 300 }) {
      const rows = await rpc(supabase, RPC.CLAIM_MAIL_JOBS, {
        p_shop_id: shopId,
        p_kinds: kinds,
        p_limit: limit,
        p_lease_seconds: leaseSeconds
      });
      return Array.isArray(rows) ? rows : [];
    },

    /** Whether any job of these kinds is due now. The worker's early wake-up. */
    async hasDue({ kinds, now = new Date() }) {
      const rows = await select(
        supabase,
        T.MAIL_JOBS,
        {
          shop_id: shopId,
          state: 'queued',
          kind: { operator: 'in', value: `(${kinds.join(',')})` },
          next_attempt_at: { operator: 'lte', value: now.toISOString() }
        },
        'id',
        { limit: 1 }
      );
      return rows.length > 0;
    },

    /** Done. Conditional on `running`, so a job reclaimed meanwhile is not closed under its new holder. */
    async complete(jobId, at = new Date()) {
      return update(
        supabase,
        T.MAIL_JOBS,
        { id: jobId, shop_id: shopId, state: 'running' },
        { state: 'done', completed_at: at.toISOString(), locked_until: null, last_error: null },
        { select: 'id' }
      );
    },

    /**
     * Count the failure: back to `queued` with backoff, or `dead` at the cap.
     * Returns the patch, so the caller can log which it was.
     */
    async fail(job, error, options = {}) {
      const patch = failurePatch(job, error, options);
      await update(supabase, T.MAIL_JOBS, { id: job.id, shop_id: shopId, state: 'running' }, patch, { select: 'id' });
      return patch;
    },

    /** Recent jobs in a state, newest first. For the status CLI and the dashboard. */
    async list({ state, limit = 50 } = {}) {
      const filters = { shop_id: shopId };
      if (state) filters.state = state;
      return select(
        supabase,
        T.MAIL_JOBS,
        filters,
        'id,kind,dedupe_key,state,retry_count,last_error,last_attempt_at,next_attempt_at,created_at',
        { order: 'created_at.desc', limit }
      );
    }
  };
}

/** One line, no stack, bounded. Never a message body. */
function oneLine(error) {
  const text = String(error?.message ?? error ?? 'unknown error').replace(/\s+/g, ' ').trim();
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

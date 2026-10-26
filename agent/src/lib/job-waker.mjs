/**
 * How the worker waits between timed polls when it has a direct connection:
 * asleep until a job is due, woken at once by a `mail_jobs` notification.
 *
 * WHY. The REST way to notice a job (the mail webhook's `sync_mailbox`, an
 * approved reply's `send_outbound`, a « Sync now ») is to ask every 15–60 s;
 * each ask is a logged API request, ~5.6k a day at 15 s. Over the direct
 * connection the questions cost no log line, and the notification makes them
 * rare: docs/decisions/ingestion.md § The worker reads and writes over a direct connection.
 *
 * THE NOTIFICATION IS ONLY A DOORBELL. It is lost if the listener is down, so
 * on every wake-up, reconnect and start the waker reads the queue itself
 * (`nextDueAt`: the earliest queued job, or the earliest lease to expire) and
 * sleeps until then, never longer than `fallbackMs`. Without a listener it does
 * exactly what the REST worker does: `hasDue` every `checkIntervalMs`.
 *
 * A JOB THAT WAS ALREADY DUE BEFORE THE LAST POLL does not wake the worker at
 * once: that poll should have taken it, so something holds it back (a send
 * with sending off, a claim that failed), and waking for it would poll in a
 * loop. It wakes the worker at the old cadence, `checkIntervalMs` after the
 * poll, as the REST check would have.
 */
export function createJobWaker({ listener = null, nextDueAt, hasDue, checkIntervalMs, fallbackMs = 300_000, logger, now = () => Date.now() }) {
  let ring = null;
  const rang = () => {
    const resolve = ring;
    ring = null;
    resolve?.();
  };
  listener?.onWake(rang);

  // Sleeps until `until`, a ring, or a stop; checks for the stop every second.
  const nap = (until, isStopping) => new Promise((resolve) => {
    let timer;
    const done = () => {
      clearInterval(timer);
      if (ring === done) ring = null;
      resolve();
    };
    ring = done;
    timer = setInterval(() => {
      if (now() >= until || isStopping()) done();
    }, Math.max(1, Math.min(1000, until - now())));
  });

  return {
    /**
     * Returns when the next poll should run: `waitMs` from now, or earlier for
     * a due job. `polledAt` is when the poll just finished began.
     */
    async wait(waitMs, isStopping, { polledAt = now() } = {}) {
      const deadline = now() + waitMs;
      const staleWakeAt = polledAt + checkIntervalMs;
      while (!isStopping() && now() < deadline) {
        if (listener?.isListening()) {
          const due = await nextDueAt().catch((error) => {
            logger?.warn('jobs.next_due_failed', { error: error.message });
            return undefined;
          });
          if (due !== undefined) {
            const dueMs = due === null ? Infinity : due.getTime();
            if (dueMs <= now()) {
              if (dueMs > polledAt || now() >= staleWakeAt) {
                logger?.info('ingest.woken_by_job', {});
                return;
              }
              await nap(Math.min(deadline, staleWakeAt), isStopping);
              continue;
            }
            await nap(Math.min(deadline, dueMs, now() + fallbackMs), isStopping);
            continue;
          }
        }
        // No listener, or the queue could not be read: the REST worker's check.
        await nap(Math.min(deadline, now() + checkIntervalMs), isStopping);
        if (isStopping()) return;
        if (await hasDue().catch(() => false)) {
          logger?.info('ingest.woken_by_job', {});
          return;
        }
      }
    }
  };
}

/** A notification's payload, `{shop_id, kind}`; anything unreadable counts as a ring. */
export function ringsFor(payload, { shopId, kinds }) {
  try {
    const { shop_id: shop, kind } = JSON.parse(payload);
    return (!shop || shop === shopId) && (!kind || kinds.includes(kind));
  } catch {
    return true;
  }
}

/**
 * LISTENs on `mail_jobs` over its own connection (a held session, which the
 * pooler's session mode gives), reconnecting with back-off. `ping` keeps the
 * connection from being dropped as idle and finds a dead one. Each (re)connect
 * rings once, so the waker re-reads the queue for anything missed meanwhile;
 * losing the connection rings too, so the waker stops trusting it at once.
 */
export function createJobListener({ connect, shopId, kinds, logger, pingMs = 240_000, maxBackoffMs = 60_000 }) {
  let client = null;
  let listening = false;
  let backoffMs = 1000;
  let stopped = false;
  let pinger = null;
  const wakers = [];
  const ringAll = () => wakers.forEach((wake) => wake());

  const retry = (reason) => {
    logger?.warn('jobs.listener_down', { reason, retryInMs: backoffMs });
    if (!stopped) setTimeout(start, backoffMs).unref?.();
    backoffMs = Math.min(maxBackoffMs, backoffMs * 2);
  };

  // Once per lost connection, however many of `error` / `end` / a failed ping report it.
  const down = (reason) => {
    if (!client) return;
    listening = false;
    clearInterval(pinger);
    const old = client;
    client = null;
    old.end().catch(() => {});
    retry(reason);
    // The waker may be asleep trusting this connection: wake it, so it falls
    // back to asking at once instead of at its next fallback read.
    ringAll();
  };

  async function start() {
    if (stopped || client) return;
    try {
      client = await connect();
      client.on('notification', (message) => {
        if (message.channel === 'mail_jobs' && ringsFor(message.payload, { shopId, kinds })) ringAll();
      });
      client.on('error', (error) => down(error.message));
      client.on('end', () => down('connection ended'));
      await client.query('LISTEN mail_jobs');
      listening = true;
      backoffMs = 1000;
      pinger = setInterval(() => {
        client?.query('select 1').catch((error) => down(`ping failed: ${error.message}`));
      }, pingMs);
      pinger.unref?.();
      logger?.info('jobs.listener_up', {});
      ringAll();
    } catch (error) {
      if (client) down(error.message);
      else retry(error.message);
    }
  }

  return {
    start,
    isListening: () => listening,
    onWake: (wake) => wakers.push(wake),
    async stop() {
      stopped = true;
      listening = false;
      clearInterval(pinger);
      await client?.end().catch(() => {});
      client = null;
    }
  };
}

import { supabaseInsert } from '../../../scripts/lib/supabase-rest-client.mjs';
import { T } from '../../../scripts/lib/tables.mjs';

import { resolveShopId } from '../lib/shop.mjs';
import { createUsageSink } from './usage-sink.mjs';

// The writer for `llm_usage`: drained sink entries in, rows out.
//
// BEST-EFFORT, AND THAT IS THE WHOLE CONTRACT. This table is a ledger of what
// the work cost, not part of the work. A poll that categorised twenty tickets
// and then failed to write its cost rows has still categorised twenty tickets,
// so `flush` swallows its own failure, logs it and returns how many rows landed.
// Letting it throw would mean the accountant could abort the pass.
//
// Append-only: `supabaseInsert`, never an upsert. There is no natural key to
// merge on — the same ticket really can be categorised twice — and a row here
// is an event, not a state.

export function createUsageStore(supabase, { shopId, logger } = {}) {
  return {
    /**
     * Writes one batch. Returns the number of rows written (0 on failure).
     *
     * ONE INSERT FOR THE WHOLE DRAIN rather than a row at a time: a busy poll
     * produces tens of entries, and a per-row write would turn a bookkeeping
     * flush into the slowest thing in the poll.
     */
    async flush(entries = []) {
      if (!Array.isArray(entries) || entries.length === 0) {
        return 0;
      }
      if (!shopId) {
        // `shop_id` is `not null`. Without one there is nothing to write and no
        // point failing over it — the entries are already drained and gone.
        logger?.warn?.('llm_usage.flush_skipped', { count: entries.length, reason: 'no shop id' });
        return 0;
      }

      try {
        await supabaseInsert(supabase, T.LLM_USAGE, entries.map((entry) => toRow(entry, shopId)));
        return entries.length;
      } catch (error) {
        // No prompt text has ever been in these entries, so the count and the
        // transport error are the whole of what there is to say.
        logger?.warn?.('llm_usage.flush_failed', {
          count: entries.length,
          error: error.message
        });
        return 0;
      }
    }
  };
}

/**
 * Sink + flush for a caller that already holds a shop id: the worker's poll and
 * the standalone passes it shares code with.
 *
 * WHY THIS EXISTS AS A NAMED THING rather than two lines at each call site. A
 * buffer nobody drains is silently equivalent to no buffer at all, and that is
 * exactly the bug this closes — the sink and this store were built, tested and
 * never constructed, so `llm_usage` held 0 rows while three LLM passes ran. Both
 * halves are handed out together here so a caller cannot take one and forget the
 * other.
 *
 * `flush` reports what was spent as well as what was stored, because the two are
 * different questions and a dry run only has an answer to the first.
 */
export function createShopUsageRecording({ supabase, shopId, logger } = {}) {
  const sink = createUsageSink();
  const store = createUsageStore(supabase, { shopId, logger });

  return {
    sink,

    /**
     * Drains the buffer and returns `{calls, tokens, written}`.
     *
     * `write: false` totals the spend and stores nothing — a dry run makes real,
     * billed model calls, so the money is worth reporting even where the run's
     * whole contract is that it writes no rows.
     *
     * DRAINS EITHER WAY. The entries describe calls that have already happened;
     * holding them back after a failed or skipped write would double-count them
     * on the next flush.
     */
    async flush({ write = true } = {}) {
      const entries = sink.drain();
      const tokens = entries.reduce((total, entry) => total + (entry.totalTokens ?? 0), 0);
      const written = write && entries.length > 0 ? await store.flush(entries) : 0;
      return { calls: entries.length, tokens, written };
    }
  };
}

/**
 * Sink + flush for a caller that holds a shop DOMAIN rather than a shop id —
 * the standalone `embed:*` reconcilers, which never needed the `shops` row for
 * anything else.
 *
 * The lookup is deferred to the flush and skipped when nothing was spent, so a
 * dry run or a key-less run still costs no extra query. It is best-effort like
 * everything else here: a shop that cannot be resolved loses the cost rows, not
 * the embedding run that produced them.
 */
export function createUsageRecording({ supabase, shopDomain, logger } = {}) {
  const sink = createUsageSink();

  return {
    sink,
    async flush() {
      const entries = sink.drain();
      if (entries.length === 0) {
        return 0;
      }
      try {
        const shopId = await resolveShopId(supabase, shopDomain);
        return await createUsageStore(supabase, { shopId, logger }).flush(entries);
      } catch (error) {
        logger?.warn?.('llm_usage.flush_failed', {
          count: entries.length,
          error: error.message
        });
        return 0;
      }
    }
  };
}

/**
 * A sink entry as the table holds it.
 *
 * `occurred_at` comes from the entry, not from the insert: a batch flushed at
 * the end of a poll would otherwise stamp every call in that poll with the same
 * instant, and "how long did this ticket take to work" stops being answerable.
 */
function toRow(entry, shopId) {
  return {
    shop_id: shopId,
    ticket_id: entry.ticketId ?? null,
    pass: entry.pass,
    model: entry.model,
    input_tokens: entry.inputTokens,
    cached_input_tokens: entry.cachedInputTokens ?? 0,
    output_tokens: entry.outputTokens,
    total_tokens: entry.totalTokens,
    call_count: entry.callCount ?? 1,
    succeeded: entry.succeeded,
    error_kind: entry.errorKind ?? null,
    occurred_at: entry.occurredAt
  };
}

import { supabaseSelect } from '../../../scripts/lib/supabase-rest-client.mjs';

/**
 * Runs a pass only when something it reads could have changed.
 *
 * WHY. Several passes are pure functions of the database plus a clock measured
 * in days: customer resolution (a 24-hour back-off), order context, the change
 * router (time windows of days), auto-close (days of silence). Each re-read its
 * whole input every poll, about 450 kB a minute between them on 2026-10-06,
 * to conclude almost every time that nothing had moved.
 *
 * WHAT COUNTS AS A CHANGE. The newest `updated_at` of each table the pass names
 * (one indexed row each). Every write to those tables moves it. So does new mail,
 * because ingestion moves `tickets.last_message_at`. A pass also runs when
 * `everyMs` has passed since its last run, for what moves with time alone (a
 * window elapsing) or outside those tables (a rule edited in Agent Setup).
 *
 * ONE READ PER TABLE PER POLL. Each table's stamp is read at its first use in a
 * poll and kept until `endPoll()`. Five passes name `tickets` and two `orders`:
 * read per pass, that was 7 of an idle poll's ~57 requests (2026-10-17).
 *
 * The stamp is taken BEFORE the pass runs, so the pass's own writes count as a
 * change: it runs once more the next poll, finds nothing to do, and the stamp
 * settles. A pass that throws is not marked, so it is retried next poll.
 */
export function createChangeGate({ read, now = () => Date.now(), everyMs = 15 * 60 * 1000 }) {
  const seen = new Map();
  let thisPoll = new Map();
  let lastPoll = new Map();
  const stampOf = (table) => {
    if (!thisPoll.has(table)) thisPoll.set(table, read(table));
    return thisPoll.get(table);
  };
  return {
    /**
     * @param name   the pass, for its own memory
     * @param tables tables whose newest `updated_at` it depends on
     * @param run    the pass; its result is returned, or null when skipped
     */
    async run(name, tables, run) {
      const stamps = await Promise.all(tables.map(stampOf));
      const stamp = stamps.join('|');
      const at = now();
      const last = seen.get(name);
      if (last && last.stamp === stamp && at - last.at < everyMs) return null;
      const result = await run();
      seen.set(name, { stamp, at });
      return result;
    },

    /**
     * Ends a poll: the next one reads every stamp afresh. Returns whether
     * anything moved: a table whose stamp differs from the previous poll, one
     * read for the first time, or one that could not be read. Never throws.
     */
    async endPoll() {
      const polled = thisPoll;
      thisPoll = new Map();
      const stamps = new Map();
      let moved = false;
      for (const [table, pending] of polled) {
        try {
          const stamp = await pending;
          stamps.set(table, stamp);
          if (lastPoll.get(table) !== stamp) moved = true;
        } catch {
          moved = true;
        }
      }
      lastPoll = stamps;
      return moved;
    }
  };
}

/**
 * The newest `updated_at` of a shop's rows in `table`, as a string, or ''.
 *
 * Plain `desc`, never `desc.nullslast`: `updated_at` is NOT NULL, so the two
 * return the same row, but only plain `desc` walks the (shop_id, updated_at)
 * index backwards. With `nullslast` Postgres read and sorted every row of the
 * shop instead: ~740 blocks on tickets, ~1,050 on orders, every poll (2026-10-17).
 */
export function latestUpdateReader(supabase, shopId) {
  return async (table) => {
    const [row] = await supabaseSelect(supabase, table, { shop_id: shopId }, 'updated_at', {
      order: 'updated_at.desc',
      limit: 1
    });
    return row?.updated_at ?? '';
  };
}

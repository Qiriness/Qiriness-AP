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
 * The stamp is taken BEFORE the pass runs, so the pass's own writes count as a
 * change: it runs once more the next poll, finds nothing to do, and the stamp
 * settles. A pass that throws is not marked, so it is retried next poll.
 */
export function createChangeGate({ read, now = () => Date.now(), everyMs = 15 * 60 * 1000 }) {
  const seen = new Map();
  return {
    /**
     * @param name   the pass, for its own memory
     * @param tables tables whose newest `updated_at` it depends on
     * @param run    the pass; its result is returned, or null when skipped
     */
    async run(name, tables, run) {
      const stamps = await Promise.all(tables.map((table) => read(table)));
      const stamp = stamps.join('|');
      const at = now();
      const last = seen.get(name);
      if (last && last.stamp === stamp && at - last.at < everyMs) return null;
      const result = await run();
      seen.set(name, { stamp, at });
      return result;
    }
  };
}

/** The newest `updated_at` of a shop's rows in `table`, as a string, or ''. */
export function latestUpdateReader(supabase, shopId) {
  return async (table) => {
    const [row] = await supabaseSelect(supabase, table, { shop_id: shopId }, 'updated_at', {
      order: 'updated_at.desc.nullslast',
      limit: 1
    });
    return row?.updated_at ?? '';
  };
}

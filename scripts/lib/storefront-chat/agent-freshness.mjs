/**
 * Keeps the storefront agent current without reloading what has not changed.
 *
 * WHY. The agent holds the whole catalogue, the policies and FAQs and the
 * advisor's knowledge: about 1.15 MB read from Supabase (2026-11-08: catalogue
 * 0.95 MB, of which product FAQs 326 kB, descriptions 188 kB, ingredients
 * 155 kB). It was rebuilt every five minutes while customers were chatting, and
 * on every cold instance, ~29 times a day, ~33 MB of a ~150 MB daily egress
 * against a ~31 MB/day budget. The sources change about once a day (the nightly
 * product sync) or when someone edits a policy.
 *
 * NOW. Every five minutes, the same moment the rebuild used to start, the agent
 * reads a fingerprint of its sources (`readSourceStamp`, a few hundred bytes a
 * table). Unchanged: the agent is renewed in place, its knowledge marked
 * checked now, so the five-minute edit boundary and the policy freshness rule
 * (DECISIONS § The agent is never served past its knowledge's lifetime) hold
 * exactly as before. Changed, unreadable, or older than a day: rebuilt as before.
 */

/** Read whole once a day at least, whatever the fingerprint says. */
export const AGENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * What the agent is built from, and how each is fingerprinted.
 *
 * - `newest`: the newest `updated_at` for the shop, one row. Enough where a row
 *   is never deleted outright: a change, a soft delete (`deleted_at`) and an
 *   insert all move it (`set_updated_at` trigger, insert default).
 * - `rows`: every row's `id,updated_at`. For the two tables the dashboard can
 *   DELETE from (an article, a policy), where a deleted row moves nothing. They
 *   are small (9 and 18 rows, ~2.7 kB together).
 * - `shop_name`: the name itself. The `shops` row's `updated_at` moves on every
 *   worker poll (its sync cursors), so it would read as a change every time.
 */
export const SOURCE_STAMPS = [
  { table: 'shops', key: 'id', how: 'shop_name' },
  { table: 'support_parameters', key: 'shop_id', how: 'newest' },
  { table: 'products', key: 'shop_id', how: 'newest' },
  { table: 'advice_collections', key: 'shop_id', how: 'newest' },
  { table: 'company_policies', key: 'shop_id', how: 'rows' },
  { table: 'knowledge_documents', key: 'shop_id', how: 'rows' },
  { table: 'advisor_playbooks', key: 'shop_id', how: 'newest' },
  { table: 'advisor_mappings', key: 'shop_id', how: 'newest' },
  { table: 'advisor_merchandising', key: 'shop_id', how: 'newest' },
  { table: 'advisor_knowledge', key: 'shop_id', how: 'newest' }
];

/**
 * One string that changes when any source changes.
 *
 * @param {(table: string, filters: object, columns: string, options?: object) => Promise<object[]>} select
 *   one page, as `supabaseSelect`
 */
export async function readSourceStamp(select, shopId) {
  if (!shopId) throw new Error('readSourceStamp needs the shop id.');
  const parts = await Promise.all(SOURCE_STAMPS.map(async ({ table, key, how }) => {
    const filters = { [key]: shopId };
    if (how === 'shop_name') {
      const [row] = await select(table, filters, 'shop_name', { limit: 1 });
      return `${table}:${row?.shop_name ?? ''}`;
    }
    if (how === 'newest') {
      // Plain `desc`, never `nullslast`: the column is NOT NULL, and nullslast
      // turns a one-row read into a sort of the table (DECISIONS § ingestion).
      const [row] = await select(table, filters, 'updated_at', { order: 'updated_at.desc', limit: 1 });
      return `${table}:${row?.updated_at ?? ''}`;
    }
    const rows = await select(table, filters, 'id,updated_at', { order: 'id.asc' });
    return `${table}:${rows.length}:${rows.map((r) => `${r.id}@${r.updated_at}`).join(',')}`;
  }));
  return parts.join('|');
}

/**
 * The agent for a request: built once, refreshed ahead of its lifetime, renewed
 * when its sources are unchanged, never served past its lifetime.
 *
 * @param {object} options
 * @param {(key: string) => Promise<{ agent: object, knowledge?: { loadedAt: number } | null, stamp: string | null }>} options.build
 *   builds the agent; `stamp` is the fingerprint read BEFORE its sources (so a
 *   change during the build is seen next time), null when it could not be read
 *   or a source failed and the agent is degraded — such an agent is never renewed
 * @param {() => Promise<string>} options.readStamp
 * @param {number} options.ttlMs        the agent's lifetime (KNOWLEDGE_TTL_MS)
 * @param {number} options.aheadMs      how long before it the check starts
 * @param {number} [options.maxAgeMs]   rebuilt whole at least this often
 * @param {() => number} [options.now]
 * @param {(error: unknown) => void} [options.onError]
 */
export function createAgentCache({ build, readStamp, now = Date.now, ttlMs, aheadMs, maxAgeMs = AGENT_MAX_AGE_MS, onError = () => {} }) {
  let remembered = null; // { at, builtAt, key, agent, knowledge, stamp }
  let refreshing = null;

  async function rebuild(key) {
    const built = await build(key);
    const at = now();
    remembered = { at, builtAt: at, key, agent: built.agent, knowledge: built.knowledge ?? null, stamp: built.stamp ?? null };
    return built.agent;
  }

  async function renewOrRebuild(key) {
    const current = remembered;
    if (current?.stamp && now() - current.builtAt < maxAgeMs) {
      let stamp = null;
      try {
        stamp = await readStamp();
      } catch (error) {
        onError(error);
      }
      if (stamp === current.stamp && remembered === current) {
        const at = now();
        // Checked against its sources just now: as fresh as a reload would be.
        if (current.knowledge) current.knowledge.loadedAt = at;
        remembered = { ...current, at };
        return current.agent;
      }
    }
    return rebuild(key);
  }

  return {
    current(key) {
      if (remembered && remembered.key === key) {
        const age = now() - remembered.at;
        if (age >= ttlMs - aheadMs && !refreshing) {
          refreshing = renewOrRebuild(key).finally(() => {
            refreshing = null;
          });
          refreshing.catch(onError);
        }
        const fallback = remembered.agent;
        if (age >= ttlMs && refreshing) return refreshing.catch(() => fallback);
        return Promise.resolve(remembered.agent);
      }
      // No agent yet (or another model): the requests arriving meanwhile share one build.
      if (!refreshing) {
        refreshing = rebuild(key).finally(() => {
          refreshing = null;
        });
      }
      return refreshing;
    },
    /** For tests and diagnostics. */
    get state() {
      return remembered && { at: remembered.at, builtAt: remembered.builtAt, stamp: remembered.stamp };
    }
  };
}

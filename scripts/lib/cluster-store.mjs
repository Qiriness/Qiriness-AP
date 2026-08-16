import {
  supabaseDelete,
  supabaseDeleteWhereIn,
  supabaseInsert,
  supabaseSelect
} from './supabase-rest-client.mjs';
import { T } from './tables.mjs';

// Persistence for the topic map that `cluster:tickets` builds.
//
// WHY THIS EXISTS. The clustering report was terminal output and nothing else:
// re-deriving it costs an all-pairs cosine comparison over the whole embedded
// corpus, so a dashboard cannot recompute it per page view, and a report that
// exists only in somebody's scrollback cannot be compared with last month's.
// A run is written once, read whole, and never mutated.
//
// Split the usual way: pure row building above, database access in the store
// below. The clustering itself stays in `cluster-messages.mjs` — nothing here
// knows what a vector is.

/**
 * How many runs to keep.
 *
 * The map is rebuilt by hand (see 06_analytics.sql), so runs accumulate at
 * human pace, not machine pace — ten is several months of deliberate rebuilds
 * and is enough history to answer "did this topic exist before?". It is a
 * ceiling rather than a target: each run also writes one row per topic, and
 * unbounded retention would grow `ticket_clusters` by the topic count on every
 * rebuild for a comparison nobody makes past the last handful.
 */
export const KEEP_RUNS = 10;

/**
 * `numeric(4,3)` columns, rounded here rather than left to Postgres.
 *
 * The database would round on the way in anyway, so a caller reading back what
 * it just wrote would get a different number from the one it sent. Rounding at
 * the boundary means the row this module builds IS the row that lands.
 */
function round3(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * 1000) / 1000
    : null;
}

/**
 * The run header.
 *
 * `built_at` is stamped by the caller rather than left to the column default:
 * the honest answer to "how old is this map?" is when the corpus was READ, and
 * a long clustering pass finishes some minutes after that.
 */
export function buildRunRow(facts) {
  return {
    shop_id: facts.shopId,
    built_at: facts.builtAt || new Date().toISOString(),
    threshold: round3(facts.threshold),
    min_size: facts.minSize,
    dedupe: round3(facts.dedupe),
    message_count: facts.messageCount ?? 0,
    internal_excluded: facts.internalExcluded ?? 0,
    subject_count: facts.subjectCount ?? 0,
    topic_count: facts.topicCount ?? 0
  };
}

/**
 * Clustering output -> `ticket_clusters` rows.
 *
 * clusters: [{ subject, clusterIndex, size, cohesion, representativeExcerpt,
 *              memberMessageIds }]
 *
 * `clusterIndex` is the topic's rank WITHIN its subject, supplied by the caller
 * rather than derived from array position here: the unique key is
 * (run_id, subject, cluster_index), so the number has to survive the two
 * subjects being interleaved in one flat list.
 */
export function buildClusterRows({ shopId, runId, clusters = [] }) {
  return clusters.map((cluster) => ({
    shop_id: shopId,
    run_id: runId,
    subject: cluster.subject,
    cluster_index: cluster.clusterIndex,
    size: cluster.size,
    cohesion: round3(cluster.cohesion),
    representative_excerpt: cluster.representativeExcerpt ?? null,
    member_message_ids: cluster.memberMessageIds ?? []
  }));
}

export function createClusterStore(supabase) {
  /**
   * Keeps the newest `keep` runs for a shop and deletes the rest. Their
   * clusters go with them — `ticket_clusters.run_id` is ON DELETE CASCADE, so
   * this is one request and cannot half-succeed into orphaned topics.
   *
   * Ordered by `built_at` with `id` as the tie-break: two runs started in the
   * same second would otherwise page in whatever order the planner chose, and
   * pruning would delete an arbitrary one of them.
   */
  async function pruneRuns(shopId, { keep = KEEP_RUNS } = {}) {
    const runs = await supabaseSelect(supabase, T.CLUSTER_RUNS, { shop_id: shopId }, 'id', {
      order: 'built_at.desc,id.desc'
    });
    const stale = runs.slice(keep).map((run) => run.id);
    await supabaseDeleteWhereIn(supabase, T.CLUSTER_RUNS, 'id', stale);
    return stale.length;
  }

  return {
    pruneRuns,

    /**
     * Writes one run and its topics.
     *
     * NO RUN ROW MAY SURVIVE WITHOUT ITS CLUSTERS. PostgREST has no
     * transaction across two requests, and the run row has to exist first
     * because the clusters carry its id — so the two writes are ordered
     * run-then-clusters and the failure path deletes the run it just created.
     * The alternative (write clusters first, then the header) is not available,
     * and leaving the orphan would be worse than failing: the dashboard reads
     * the NEWEST run, so a headless run row does not look like an error, it
     * looks like a rebuild that honestly found no recurring topics. A wrong
     * answer beats a missing one only in the other direction.
     *
     * The window in which the orphan exists is one HTTP round trip, and the
     * only reader is a dashboard refreshed by hand — which is why a
     * compensating delete is enough here and a stored procedure is not needed.
     */
    async saveRun(runFacts, clusters = []) {
      const [run] = await supabaseInsert(supabase, T.CLUSTER_RUNS, [buildRunRow(runFacts)]);
      if (!run?.id) {
        throw new Error('cluster_runs insert returned no row; nothing to attach clusters to.');
      }

      try {
        // A run that found nothing is a legitimate result, not a failure: it
        // says the corpus has no repeated topic above the threshold, which is
        // exactly what a reader tuning the threshold needs to see. `supabaseInsert`
        // is a no-op on an empty list, so this costs no request.
        await supabaseInsert(
          supabase,
          T.TICKET_CLUSTERS,
          buildClusterRows({ shopId: runFacts.shopId, runId: run.id, clusters })
        );
      } catch (error) {
        // Best-effort: if the cleanup itself fails there is nothing further to
        // try, and the original error is the one worth reporting.
        await supabaseDelete(supabase, T.CLUSTER_RUNS, { id: run.id }).catch(() => {});
        throw error;
      }

      const prunedRuns = await pruneRuns(runFacts.shopId);
      return { runId: run.id, clusterCount: clusters.length, prunedRuns };
    },

    /**
     * The newest run and its topics — what a dashboard renders.
     *
     * Two reads rather than a PostgREST embed: the clusters are ordered by size
     * (the order the report ranks them in, and the only order a reader wants),
     * and an embedded resource cannot be ordered independently of its parent.
     */
    async latestRun(shopId) {
      const [run] = await supabaseSelect(
        supabase,
        T.CLUSTER_RUNS,
        { shop_id: shopId },
        'id,built_at,threshold,min_size,dedupe,message_count,internal_excluded,' +
          'subject_count,topic_count',
        { order: 'built_at.desc,id.desc', limit: 1 }
      );
      if (!run) {
        return null;
      }

      const clusters = await supabaseSelect(
        supabase,
        T.TICKET_CLUSTERS,
        { run_id: run.id },
        'id,subject,cluster_index,size,cohesion,representative_excerpt,member_message_ids',
        { order: 'size.desc,subject.asc,cluster_index.asc' }
      );
      return { run, clusters };
    }
  };
}

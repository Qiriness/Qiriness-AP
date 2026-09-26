// Moving stored Graph message ids from REST ids to immutable ids, once.
//
// WHY IT IS A MIGRATION AND NOT A HEADER. `graph_message_id` is the idempotency
// key of three tables and what `knownMessageIds` compares against. Asking Graph
// for immutable ids while the rows hold REST ids would make every re-delivered
// message look new: a second copy of all of them, closed tickets reopened, the
// whole corpus re-queued for categorisation — the 2026-08-20 incident again
// (DECISIONS.md § "Re-delivery is not arrival"). So the stored ids move first,
// and the poller follows a marker this migration writes last.
//
// Pure functions here; `tools/run-translate-message-ids.mjs` does the I/O.

/** Every table that stores a Graph message id, and nothing else does. */
export const ID_TABLES = ['ticket_messages', 'spam_audit', 'categorisation_review'];

/**
 * What to write, from the stored rows and Graph's translation of their ids.
 *
 * @param rowsByTable { [table]: [{ id, graph_message_id }] }
 * @param results [{ sourceId, targetId | null, error | null }]
 * @returns {{ updates: {table, id, from, to}[], failed: {[code]: number},
 *            failedByTable: {[table]: number}, conflicts: string[] }}
 *
 * A FAILED ID KEEPS ITS OLD VALUE. Mail deleted since cannot be translated, and
 * it will never be delivered again either, so its old id collides with nothing.
 *
 * A CONFLICT STOPS EVERYTHING: two stored ids translating to one target within a
 * table, or a target equal to another row's stored id. Either would break the
 * table's unique key half-way through the writes.
 */
export function planIdTranslation(rowsByTable, results) {
  const targetOf = new Map(results.map((r) => [r.sourceId, r]));
  const updates = [];
  const failed = {};
  const failedByTable = {};
  const conflicts = [];

  for (const [table, rows] of Object.entries(rowsByTable)) {
    const stored = new Set(rows.map((row) => row.graph_message_id));
    const claimed = new Map();
    for (const row of rows) {
      const result = targetOf.get(row.graph_message_id);
      if (!result?.targetId) {
        const code = result?.error || 'NotTranslated';
        failed[code] = (failed[code] || 0) + 1;
        failedByTable[table] = (failedByTable[table] || 0) + 1;
        continue;
      }
      if (result.targetId === row.graph_message_id) {
        continue;
      }
      if (claimed.has(result.targetId)) {
        conflicts.push(`${table}: rows ${claimed.get(result.targetId)} and ${row.id} translate to one id`);
        continue;
      }
      if (stored.has(result.targetId)) {
        conflicts.push(`${table}: row ${row.id} translates to an id another row already holds`);
        continue;
      }
      claimed.set(result.targetId, row.id);
      updates.push({ table, id: row.id, from: row.graph_message_id, to: result.targetId });
    }
  }

  return { updates, failed, failedByTable, conflicts };
}

/**
 * The proof that the translation is what the poller will see: the ids Graph's
 * delta returns under `IdType="ImmutableId"`, joined to the translated ids on
 * internetMessageId. Any difference means the migration would not prevent the
 * duplicates it exists to prevent.
 */
export function compareWithDelta(storedMessages, translatedBySource, deltaMessages) {
  const expected = new Map();
  for (const row of storedMessages) {
    const target = translatedBySource.get(row.graph_message_id);
    if (row.internet_message_id && target) {
      expected.set(row.internet_message_id, target);
    }
  }

  let equal = 0;
  let differ = 0;
  for (const message of deltaMessages) {
    const target = expected.get(message?.internetMessageId);
    if (!target) continue;
    if (target === message.id) equal += 1;
    else differ += 1;
  }
  return { equal, differ };
}

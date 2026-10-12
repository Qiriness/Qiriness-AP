/**
 * The management chat's contract with the database, checked.
 *
 * WHY. The chat model writes SQL against the `chat` views and learns them only
 * from the schema text `loadSchemaText` renders (names, types, comments). Nothing
 * at compile time sees that text, so a migration that drops a column a view
 * needs, changes a function a view calls, or rewrites a comment the model relies
 * on breaks the chat silently: the dashboard keeps working and the chat starts
 * answering "the query failed". Two checks close that:
 *
 *   1. RUNS. Every view is executed as the chat role — the role the model's
 *      queries use — one row, counted, never returned. That catches a missing
 *      grant or a broken function inside a view, which a catalogue read cannot.
 *   2. SAYS THE SAME THING. The rendered schema text is compared with the
 *      committed snapshot `supabase/chat-contract.snapshot.txt`. A difference is
 *      not necessarily wrong, but it is a change to what the model is told, so it
 *      is reviewed and accepted with `--update` rather than shipped unseen.
 */
import { loadSchemaText } from './chat-sql-executor.mjs';

/** Every view in `chat`, executed as the connected role; never returns row data. */
export async function runEveryView(client) {
  const { rows } = await client.query(
    `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'chat' and c.relkind in ('v', 'm') order by 1`
  );
  const results = [];
  for (const { name } of rows) {
    try {
      await client.query('begin read only');
      await client.query(`select count(*) from (select * from chat."${name.replaceAll('"', '""')}" limit 1) s`);
      results.push({ view: name, ok: true });
    } catch (error) {
      results.push({ view: name, ok: false, error: String(error?.message || error) });
    } finally {
      await client.query('rollback').catch(() => {});
    }
  }
  return results;
}

/** Lines present in one text and not the other, in order. Pure. */
export function diffLines(expected, actual) {
  const a = String(expected ?? '').split(/\r?\n/);
  const b = String(actual ?? '').split(/\r?\n/);
  const inB = new Set(b);
  const inA = new Set(a);
  return [
    ...a.filter((line) => !inB.has(line)).map((line) => `- ${line}`),
    ...b.filter((line) => !inA.has(line)).map((line) => `+ ${line}`)
  ];
}

/**
 * Both checks. `snapshot` is the committed text (null when none exists yet).
 * @returns {{ ok: boolean, failed: object[], changed: string[], text: string, views: number }}
 */
export async function checkChatContract(client, snapshot) {
  const views = await runEveryView(client);
  const text = await loadSchemaText(client);
  const changed = snapshot === null ? [] : diffLines(snapshot, text);
  const failed = views.filter((v) => !v.ok);
  return { ok: failed.length === 0 && changed.length === 0 && snapshot !== null, failed, changed, text, views: views.length };
}

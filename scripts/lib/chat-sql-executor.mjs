/**
 * Runs the management chat's SQL as `mgmt_chat_ro`, and reads the schema the
 * model is shown.
 *
 * ONE QUERY, ONE TRANSACTION, ALWAYS ROLLED BACK. Each query gets
 * `begin ... read only`, a `set local statement_timeout`, the checked query
 * wrapped with its row cap, and a rollback whatever happened. The role already
 * carries the same timeout and read-only default (17_management_chat.sql); these
 * repeat it per query so neither depends on the other being configured.
 *
 * NEVER THROWS FOR A BAD QUERY. A refused, failed or timed-out query resolves
 * `{ok: false, error}` — the agent loop hands that to the model to correct.
 * It DOES throw when no connection can be had: that is not the model's to fix,
 * and the turn should fail as an error rather than an answer about the data.
 *
 * `pg` lives here, in a module, rather than in web/: the root package owns the
 * dependency and its use (apply-supabase-migration.mjs), and the executor is
 * tested with a fake pool.
 */

import pg from 'pg';

import { MAX_ROWS, checkSql, wrapForExecution } from './chat-sql-guard.mjs';

export const QUERY_TIMEOUT_MS = 10_000;

/** Rows kept per query for the log, so a reopened answer still shows its basis. */
export const LOG_PREVIEW_ROWS = 50;

/**
 * A small pool on the chat role's connection string.
 *
 * `query_timeout` is the client-side backstop for a server that stops
 * answering: the server-side timeout cannot fire if the connection is gone.
 */
export function createChatPool(connectionString) {
  const pool = new pg.Pool({
    connectionString,
    max: 3,
    ssl: { rejectUnauthorized: false },
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    query_timeout: QUERY_TIMEOUT_MS + 5_000,
    application_name: 'qiriness-management-chat'
  });
  // An idle client dropped by the pooler must not become an unhandled error.
  pool.on('error', () => {});
  return pool;
}

export class ChatDatabaseUnavailableError extends Error {}

/**
 * @param {{pool: {connect: () => Promise<any>}, timeoutMs?: number, maxRows?: number, now?: () => number}} options
 * @returns {(sql: string) => Promise<{ok: boolean, columns: string[], rows: unknown[][], rowCount: number,
 *   truncated: boolean, durationMs: number, error: string|null, refused?: boolean}>}
 */
export function createSqlExecutor({ pool, timeoutMs = QUERY_TIMEOUT_MS, maxRows = MAX_ROWS, now = () => Date.now() }) {
  return async function executeSql(input) {
    const checked = checkSql(input);
    if (!checked.ok) return failure(checked.error, 0, { refused: true });

    const started = now();
    let client;
    try {
      client = await pool.connect();
    } catch (error) {
      throw new ChatDatabaseUnavailableError(`The chat database could not be reached: ${error.message}`);
    }

    try {
      await client.query('begin transaction read only');
      await client.query(`set local statement_timeout = ${Math.floor(timeoutMs)}`);
      const result = await client.query({ text: wrapForExecution(checked.sql, maxRows), rowMode: 'array' });
      const truncated = result.rows.length > maxRows;
      const rows = truncated ? result.rows.slice(0, maxRows) : result.rows;
      return {
        ok: true,
        columns: result.fields.map((field) => field.name),
        rows,
        rowCount: rows.length,
        truncated,
        durationMs: now() - started,
        error: null
      };
    } catch (error) {
      return failure(describeError(error, timeoutMs), now() - started);
    } finally {
      await client.query('rollback').catch(() => {});
      client.release();
    }
  };
}

function failure(error, durationMs, extra = {}) {
  return { ok: false, columns: [], rows: [], rowCount: 0, truncated: false, durationMs, error, ...extra };
}

/**
 * The Postgres error, reworded where the raw message would send the model the
 * wrong way. A timeout reads as "canceling statement due to user request",
 * which invites a retry of the same query.
 */
export function describeError(error, timeoutMs = QUERY_TIMEOUT_MS) {
  switch (error?.code) {
    case '57014':
      return `The query was stopped after ${Math.round(timeoutMs / 1000)} s. Simplify it: aggregate, filter the date range, or avoid scanning order_lines for every order.`;
    case '42501':
      return 'Permission denied: only the views in the chat schema can be read.';
    case '25006':
      return 'This connection is read-only.';
    default:
      return error?.message ? String(error.message) : 'The query failed.';
  }
}

// --- the schema the model is shown ---------------------------------------------

/**
 * Every view in `chat`, its columns and types, and the comments written for the
 * model in 17_management_chat.sql. Read by the application, never by the model.
 */
export const SCHEMA_QUERY = `
select
  c.relname as view_name,
  obj_description(c.oid, 'pg_class') as view_comment,
  a.attname as column_name,
  format_type(a.atttypid, a.atttypmod) as data_type,
  col_description(c.oid, a.attnum) as column_comment
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
where n.nspname = 'chat' and c.relkind in ('v', 'm')
order by c.relname, a.attnum`;

/** The schema as compact text: one block per view, a line per column. Pure. */
export function renderSchema(rows) {
  const views = new Map();
  for (const row of rows ?? []) {
    if (!views.has(row.view_name)) views.set(row.view_name, { comment: row.view_comment, columns: [] });
    views.get(row.view_name).columns.push(row);
  }
  return [...views.entries()]
    .map(([name, view]) => {
      const head = `chat.${name}${view.comment ? ` — ${view.comment}` : ''}`;
      const columns = view.columns.map(
        (column) =>
          `  ${column.column_name} ${column.data_type}${column.column_comment ? ` — ${column.column_comment}` : ''}`
      );
      return [head, ...columns].join('\n');
    })
    .join('\n\n');
}

export async function loadSchemaText(pool) {
  const result = await pool.query(SCHEMA_QUERY);
  const text = renderSchema(result.rows);
  if (!text) throw new ChatDatabaseUnavailableError('The chat schema has no views readable by this connection.');
  return text;
}

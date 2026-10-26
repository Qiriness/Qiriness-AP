/**
 * The direct Postgres transport behind the REST helpers (`supabase-rest-client.mjs`).
 *
 * WHY. A PostgREST request writes a line to Supabase's API logs and a direct
 * query does not; the worker and the nightly were ~26k requests, ~41 MB of log
 * ingest a day (2026-10-26). Same rows, same JSON, no log line. See
 * `docs/decisions/ingestion.md` § The worker reads and writes over a direct connection.
 *
 * OPT-IN, PER PROCESS. `createSupabaseClient` attaches `pg` only when the config
 * says `dbTransport: 'pg'` and carries `dbUrl` (`SUPABASE_DB_TRANSPORT=pg`,
 * `WORKER_DB_URL`). The dashboard never sets them and never loads this module:
 * the REST client imports it lazily, on a client that has `pg`.
 *
 * SAME ACCESS AS THE SERVICE KEY. The login role (`qiriness_worker`, migration
 * direct_worker_connection) holds nothing itself and logs in acting as `service_role`, the
 * role PostgREST runs a service-key request as, with PostgREST's `search_path`
 * (both role settings in the database, so no connection can miss them).
 *
 * TLS IS VERIFIED against Supabase's root CA (`certs/supabase-root-2021.crt`),
 * which the pooler's chain ends in and which no system store carries.
 *
 * FALLBACK, AT STARTUP ONLY. If the very first connection cannot be made, the
 * client goes back to REST for the rest of the process and says so loudly: mail
 * keeps flowing, at the old log cost. Once a connection has worked, a later
 * failure is retried and then thrown, as a REST failure is.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { buildDelete, buildInsert, buildRpc, buildSelect, buildUpdate, pickFunction } from './supabase-pg-sql.mjs';

const SUPABASE_ROOT_CA = readFileSync(new URL('./certs/supabase-root-2021.crt', import.meta.url), 'utf8');
const RETRY_ATTEMPTS = 4;
const RETRY_BASE_MS = 400;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Errors where the query did not reach a working server: the connection broke,
 * was refused or timed out, or the server is going away. Retried like a REST
 * network error or 5xx. An error Postgres raised about the query itself is not.
 */
export function isConnectionError(error) {
  const code = String(error?.code ?? '');
  if (/^08/.test(code) || ['57P01', '57P02', '57P03', '53300'].includes(code)) return true;
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) return true;
  return /Connection terminated|connection timeout|Client has encountered a connection error/i.test(String(error?.message ?? ''));
}

/** Connection settings for a URL: the pinned CA, keep-alive, a name in pg_stat_activity. */
export function connectionConfig(url, applicationName) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.slice(1)) || 'postgres',
    ssl: { ca: SUPABASE_ROOT_CA, rejectUnauthorized: true, servername: parsed.hostname },
    application_name: applicationName,
    keepAlive: true,
    connectionTimeoutMillis: 10000
  };
}


function createPool({ url, applicationName, max = 3 }, state) {
  const pool = new pg.Pool({
    ...connectionConfig(url, applicationName),
    max,
    // Connections are kept, not reopened per query: the pooler logs a session,
    // and a poll every few minutes would otherwise reconnect each time.
    idleTimeoutMillis: 0,
    // A script ends when its work does, without having to close the pool.
    allowExitOnIdle: true
  });
  pool.on('connect', () => {
    state.connected = true;
  });
  // An idle connection the server drops emits here; without a listener it
  // would crash the process. The pool discards it and opens a new one on demand.
  pool.on('error', (error) => {
    console.error(JSON.stringify({ level: 'warn', event: 'db.pg_idle_error', error: error.message }));
  });
  return pool;
}

/**
 * The client's transport state, created on first use: `{ pool, connected,
 * failed, functions }`. `client.pg` holds the settings until then.
 */
function stateOf(client) {
  if (!client.pg.state) {
    const state = { connected: false, failed: false, functions: new Map() };
    state.pool = createPool(client.pg, state);
    client.pg.state = state;
  }
  return client.pg.state;
}

/** False once the startup connection has failed: the caller then uses REST. */
export function pgUsable(client) {
  return Boolean(client.pg) && !client.pg.state?.failed;
}

async function run(client, query, attempt = 1) {
  const state = stateOf(client);
  try {
    return await state.pool.query(query);
  } catch (error) {
    if (!state.connected) {
      // No connection has ever been made, so this is the connection failing —
      // refused, unreachable, a bad password or certificate. The startup
      // fallback: every later call goes to REST.
      state.failed = true;
      console.error(JSON.stringify({
        level: 'error',
        event: 'db.transport_fallback',
        message: 'Direct database connection failed at startup; using the REST API instead (every request is logged by Supabase again).',
        error: error.message
      }));
      state.pool.end().catch(() => {});
      throw Object.assign(new Error(`direct connection unavailable: ${error.message}`), { fallback: true });
    }
    if (!isConnectionError(error)) throw error;
    if (attempt >= RETRY_ATTEMPTS) {
      throw new Error(`Database query failed after ${attempt} attempts: ${error.message}`);
    }
    await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    return run(client, query, attempt + 1);
  }
}

/** PostgREST's message on failure is Postgres's own, so the wording matches the REST helpers'. */
async function body(client, query, failure) {
  try {
    const result = await run(client, query);
    return result.rows[0]?.body;
  } catch (error) {
    if (error.fallback) throw error;
    throw new Error(`${failure}: ${error.message}`);
  }
}

export async function pgSelect(client, { table, select, filters, order, limit, offset }) {
  return body(client, buildSelect({ table, select, filters, order, limit, offset }), `Supabase select from ${table} failed`);
}

export async function pgInsert(client, { table, rows, onConflict, minimal }) {
  const verb = onConflict ? 'upsert into' : 'insert into';
  const result = await body(client, buildInsert({ table, rows, onConflict, minimal }), `Supabase ${verb} ${table} failed`);
  return minimal ? [] : result;
}

export async function pgUpdate(client, { table, filters, row, select, minimal }) {
  const result = await body(client, buildUpdate({ table, filters, row, select, minimal }), `Supabase update ${table} failed`);
  return minimal ? null : result;
}

export async function pgDelete(client, { table, filters, minimal }) {
  const result = await body(client, buildDelete({ table, filters, minimal }), `Supabase delete from ${table} failed`);
  return minimal ? null : result;
}

const FUNCTIONS_SQL = `
  select p.oid, p.proname as name, p.proretset as returns_set, t.typtype, p.prorettype = 'void'::regtype as returns_void,
    p.pronargs, p.pronargdefaults, coalesce(p.proargnames, '{}') as arg_names, coalesce(p.proargmodes::text[], '{}') as arg_modes,
    array(select format_type(x, null) from unnest(p.proargtypes) x) as in_types,
    p.prorettype = 'record'::regtype or t.typtype = 'c' as returns_rows
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_type t on t.oid = p.prorettype
  where n.nspname = 'public' and p.proname = $1 and p.prokind = 'f'`;

/** A function's overloads as `{ name, argTypes, required, returnsSet, returnsRows, returnsVoid }`. */
function describeFunctions(rows) {
  return rows.map((row) => {
    // proargnames lists every argument, OUT ones included; proargtypes only the inputs.
    const names = row.arg_modes.length
      ? row.arg_names.filter((_, i) => ['i', 'b', 'v'].includes(row.arg_modes[i]))
      : row.arg_names.slice(0, row.pronargs);
    const argTypes = Object.fromEntries(names.map((name, i) => [name, row.in_types[i]]));
    return {
      name: row.name,
      argTypes,
      required: names.slice(0, row.pronargs - row.pronargdefaults),
      returnsSet: row.returns_set,
      returnsRows: row.returns_rows,
      returnsVoid: row.returns_void
    };
  });
}

export async function pgRpc(client, functionName, args = {}) {
  const state = stateOf(client);
  if (!state.functions.has(functionName)) {
    const result = await run(client, { text: FUNCTIONS_SQL, values: [functionName] });
    state.functions.set(functionName, describeFunctions(result.rows));
  }
  const fn = pickFunction(state.functions.get(functionName), functionName, Object.keys(args));
  const query = buildRpc({ fn, args });
  try {
    const result = await run(client, query);
    return query.void ? null : result.rows[0]?.body;
  } catch (error) {
    if (error.fallback) throw error;
    throw new Error(`Supabase rpc ${functionName} failed: ${error.message}`);
  }
}

/** Closes the pool, for a caller that wants to end before its idle connections would. */
export async function pgClose(client) {
  if (client.pg?.state && !client.pg.state.failed) await client.pg.state.pool.end();
}

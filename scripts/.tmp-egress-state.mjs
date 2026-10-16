// Read-only: worker liveness, stats window, nightly runs, auth-role traffic.
import pg from 'pg';
import { loadEnv } from './lib/sync-config.mjs';
const env = loadEnv();
const c = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const q = async (label, sql) => { try { const { rows } = await c.query(sql); console.log('\n##', label); console.table(rows); } catch (e) { console.log('\n##', label, 'ERR', e.message); } };
await q('now / stats', `select now(), (select stats_reset from pg_stat_statements_info), (select dealloc from pg_stat_statements_info)`);
await q('latest writes', `select 'ticket_messages' t, max(created_at) from ticket_messages union all select 'tickets', max(updated_at) from tickets union all select 'mail_jobs', max(updated_at) from mail_jobs union all select 'llm_usage', max(created_at) from llm_usage`);
await q('integration_events recent', `select event_type, status, max(created_at) last, count(*) from integration_events where created_at > now() - interval '10 days' group by 1,2 order by 3 desc limit 25`);
await q('calls by role', `select r.rolname, sum(calls)::bigint calls, round(sum(total_exec_time)) ms, sum(rows)::bigint rows, sum(shared_blks_hit+shared_blks_read)::bigint blks from pg_stat_statements s join pg_roles r on r.oid=s.userid group by 1 order by 2 desc`);
await q('auth top', `select calls, rows, left(regexp_replace(query,'\s+',' ','g'),160) q from pg_stat_statements s join pg_roles r on r.oid=s.userid where r.rolname='supabase_auth_admin' order by calls desc limit 12`);
await q('auth sessions', `select count(*) total, count(*) filter (where updated_at > now()-interval '1 day') touched_1d, max(updated_at) from auth.sessions`);
await q('refresh tokens 3d', `select date_trunc('hour', created_at) h, count(*) from auth.refresh_tokens where created_at > now()-interval '3 days' group by 1 order by 1 desc limit 30`);
await q('audit log 3d', `select payload->>'action' action, count(*), max(created_at) from auth.audit_log_entries where created_at > now()-interval '3 days' group by 1 order by 2 desc`);
await c.end();

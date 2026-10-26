-- ============================================================================
-- 01 — THE WORKER'S DIRECT CONNECTION, AND A DOORBELL ON MAIL JOBS
--
-- WHAT THIS ADDS.
--   `qiriness_worker` — the login role the worker and the nightly connect as
--     over the session pooler (WORKER_DB_URL), instead of calling the REST API.
--     It holds no rights of its own (noinherit): it logs in acting as
--     `service_role`, the role a service-key REST request runs as, so the
--     access is exactly today's (owner's choice, 2026-10-26). Its own password,
--     so it can be rotated without touching the service key or `postgres`.
--     PostgREST's limits: 8 s per statement and per lock wait.
--   `mail_jobs_notify` — after a job is queued (enqueued, brought forward, or
--     put back after a failure), `pg_notify('mail_jobs', {shop_id, kind})`. The
--     worker LISTENs and wakes at once instead of asking every 15–60 s.
--
-- WHY (2026-10-26). Supabase logs every REST request, ~1.6 kB each, and log
-- ingest is a metered quota: ~50 MB a day against a 1 GB cycle. The worker's
-- polls and its "is a job due?" check were ~57% of the 26k requests a day. A
-- query over a direct connection writes no log line. docs/decisions/ingestion.md
-- § The worker reads and writes over a direct connection.
--
-- THE NOTIFICATION IS ONLY A DOORBELL. It carries no job, is delivered only on
-- commit, and is lost if nobody is listening; the jobs table stays the truth.
-- The worker re-reads the queue on every wake-up, reconnect and start.
--
-- THE PASSWORD IS NOT HERE: `node scripts/set-worker-db-password.mjs` sets it
-- (as a SCRAM verifier, so the DDL log never holds the password) and writes
-- WORKER_DB_URL to .env.local.
--
-- Requires: nothing. Idempotent.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'qiriness_worker') then
    create role qiriness_worker login noinherit connection limit 10;
  end if;
end
$$;

grant service_role to qiriness_worker;
-- Logged in, it acts as service_role at once, with PostgREST's search_path: no
-- per-connection SET for a client to forget (and the LISTEN connection gets it too).
alter role qiriness_worker set role = 'service_role';
alter role qiriness_worker set search_path = public, extensions;
alter role qiriness_worker set statement_timeout = '8s';
alter role qiriness_worker set lock_timeout = '8s';
alter role qiriness_worker set idle_in_transaction_session_timeout = '60s';

create or replace function public.mail_jobs_notify()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform pg_notify('mail_jobs', json_build_object('shop_id', new.shop_id, 'kind', new.kind)::text);
  return null;
end
$$;

comment on function public.mail_jobs_notify() is
  'Trigger: pg_notify(''mail_jobs'', {shop_id, kind}) after a job is queued. A wake-up for the worker, never the job itself.';

revoke all on function public.mail_jobs_notify() from public, anon, authenticated;

drop trigger if exists mail_jobs_notify on public.mail_jobs;
create trigger mail_jobs_notify
  after insert or update of state, next_attempt_at on public.mail_jobs
  for each row
  when (new.state = 'queued')
  execute function public.mail_jobs_notify();

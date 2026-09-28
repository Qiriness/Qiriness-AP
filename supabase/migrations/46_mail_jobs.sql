-- ============================================================================
-- 46 — THE MAIL JOB QUEUE AND PROVIDER SUBSCRIPTIONS
--
-- `mail_jobs` (sync_mailbox / send_outbound, retries with backoff, dead after
-- a cap), `enqueue_mail_job()` and `claim_mail_jobs()`, and
-- `mail_subscriptions` (one change-notification subscription per shop and
-- folder, client state stored hashed).
--
-- NO DATA IS WRITTEN. COPIED FROM 04_support.sql (46_mail_jobs.test.mjs
-- asserts the two agree). IDEMPOTENT.
--
-- Requires: 01_foundation.sql (shops, set_updated_at).
-- ============================================================================

-- ---------------------------------------------------------------- mail_jobs

-- The durable queue between whatever asks for mail work and the worker that
-- does it. Two kinds, and only two:
--
--   sync_mailbox   "read this folder now". Enqueued by a provider change
--                  notification (the webhook). The worker's own poll reads
--                  both folders on a timer anyway, so this only shortens the
--                  wait: the poll is the truth, a job is a nudge.
--   send_outbound  "carry out this outbound action". Enqueued when a reply is
--                  approved; the action row (outbound_actions, 07) holds the
--                  business state, this row holds the attempts.
--
-- CASE PROCESSING IS NOT A JOB KIND. The pipeline's queues are derived from
-- the `needs_*` flags on `tickets`, which ingestion raises only for mail it
-- did not already hold (DECISIONS.md § Re-delivery is not arrival). A job per
-- message beside them would be a second source of truth for the same fact.
--
-- DEDUPED AMONG QUEUED ROWS ONLY. A burst of notifications for one folder
-- collapses into one queued job. A job already RUNNING does not absorb a new
-- one: its read may already be past the mail the notification is about.
--
-- Retries: `fail` pushes `next_attempt_at` out with backoff and counts the
-- attempt; past the cap the row goes `dead` and stays, visible, for a person.
-- A running row whose lease ran out (the worker died mid-job) is claimable
-- again, and that reclaim counts as an attempt, so a job that kills the worker
-- every time still reaches the cap.
create table if not exists public.mail_jobs (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,

  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  -- `sync:<folder>` or `send:<outbound action id>`.
  dedupe_key text not null,

  state text not null default 'queued',
  retry_count integer not null default 0,
  -- One line, no stack, no message body.
  last_error text,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  completed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint mail_jobs_kind_check check (kind in ('sync_mailbox', 'send_outbound')),
  constraint mail_jobs_state_check check (state in ('queued', 'running', 'done', 'dead')),
  constraint mail_jobs_retry_count_check check (retry_count >= 0),
  constraint mail_jobs_payload_check check (jsonb_typeof(payload) = 'object')
);

create unique index if not exists mail_jobs_queued_dedupe_idx
  on public.mail_jobs (shop_id, dedupe_key)
  where state = 'queued';

create index if not exists mail_jobs_due_idx on public.mail_jobs (shop_id, state, next_attempt_at);

drop trigger if exists mail_jobs_set_updated_at on public.mail_jobs;
create trigger mail_jobs_set_updated_at
before update on public.mail_jobs
for each row
execute function public.set_updated_at();

alter table public.mail_jobs enable row level security;

comment on table public.mail_jobs is
  'Durable queue for mail work: sync_mailbox (a change notification asking for a folder to be read now) and send_outbound (carry out one outbound_actions row). Retries with backoff, dead after a cap, every attempt recorded. Case processing is deliberately not a kind: it runs off the needs_* flags ingestion raises only for new mail. Written only by scripts/lib/mail-job-record.mjs.';

comment on column public.mail_jobs.dedupe_key is
  'sync:<folder> or send:<outbound action id>. Unique among QUEUED rows only, so a burst of notifications collapses into one job while a job already running never swallows a newer request.';

comment on column public.mail_jobs.state is
  'queued -> running -> done, or dead once retry_count reaches the cap. A running row whose locked_until has passed is claimable again (the worker died holding it).';

comment on column public.mail_jobs.retry_count is
  'Failed attempts so far, including a lease that ran out. Compared against MAIL_JOB_MAX_ATTEMPTS by the worker.';

comment on column public.mail_jobs.next_attempt_at is
  'Not claimable before this. Pushed out with exponential backoff on each failure (scripts/lib/mail-job-record.mjs backoffMs).';

-- Enqueue, collapsing into a job already queued under the same key. PostgREST
-- cannot name a partial index as its conflict target, hence a function. On a
-- collision the queued row keeps its id and is brought forward if the new
-- request is due sooner, so a notification never waits out a retry backoff.
create or replace function public.enqueue_mail_job(
  p_shop_id uuid,
  p_kind text,
  p_dedupe_key text,
  p_payload jsonb default '{}'::jsonb,
  p_run_at timestamptz default now()
)
returns setof public.mail_jobs
language sql
volatile
set search_path = public
as $$
  with queued as (insert into public.mail_jobs (shop_id, kind, dedupe_key, payload, next_attempt_at)
    values (p_shop_id, p_kind, p_dedupe_key, coalesce(p_payload, '{}'::jsonb), coalesce(p_run_at, now()))
    on conflict (shop_id, dedupe_key) where state = 'queued'
    do update set next_attempt_at = least(public.mail_jobs.next_attempt_at, excluded.next_attempt_at)
    returning *
  )
  select * from queued;
$$;

comment on function public.enqueue_mail_job is
  'Queue one mail job, or bring an already-queued job with the same dedupe_key forward. Returns the queued row.';

-- Claim due jobs for this worker, atomically. SKIP LOCKED so two workers never
-- take the same row; the lease (`locked_until`) is how a dead worker's job
-- comes back.
create or replace function public.claim_mail_jobs(
  p_shop_id uuid,
  p_kinds text[],
  p_limit integer,
  p_lease_seconds integer
)
returns setof public.mail_jobs
language sql
volatile
set search_path = public
as $$
  with claimed as (update public.mail_jobs j
    set state = 'running',
        locked_until = now() + make_interval(secs => greatest(p_lease_seconds, 1)),
        last_attempt_at = now(),
        retry_count = j.retry_count + case when j.state = 'running' then 1 else 0 end
    where j.id in (
      select c.id
      from public.mail_jobs c
      where c.shop_id = p_shop_id
        and c.kind = any (p_kinds)
        and (
          (c.state = 'queued' and c.next_attempt_at <= now())
          or (c.state = 'running' and c.locked_until < now())
        )
      order by c.next_attempt_at, c.created_at
      limit greatest(p_limit, 0)
      for update skip locked
    )
    returning j.*
  )
  select * from claimed;
$$;

comment on function public.claim_mail_jobs is
  'Take up to p_limit due jobs of the given kinds: queued and due, or running with an expired lease (counted as a failed attempt). Marks them running with a lease of p_lease_seconds.';

-- ---------------------------------------------------------------- mail_subscriptions

-- One provider change-notification subscription per shop and folder. The
-- subscription is only a trigger (see mail_jobs); losing one costs latency,
-- never mail, because the poll reads both folders regardless.
--
-- THE CLIENT STATE IS STORED HASHED. It is the shared secret a notification
-- must echo to be believed; the webhook hashes what arrives and compares.
create table if not exists public.mail_subscriptions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,

  provider text not null,
  folder text not null,
  -- The provider's id for the subscription. Replaced in place when it is
  -- recreated, so there is one row per shop, provider and folder.
  subscription_id text not null unique,
  client_state_hash text not null,
  expires_at timestamptz not null,
  last_renewed_at timestamptz,
  -- Set by a lifecycle notification (reauthorisation required, removed);
  -- cleared by the next successful renewal.
  needs_renewal boolean not null default false,
  last_error text,
  last_error_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint mail_subscriptions_provider_check check (provider in ('outlook')),
  constraint mail_subscriptions_folder_check check (folder in ('inbox', 'sentitems')),
  constraint mail_subscriptions_shop_folder_key unique (shop_id, provider, folder)
);

drop trigger if exists mail_subscriptions_set_updated_at on public.mail_subscriptions;
create trigger mail_subscriptions_set_updated_at
before update on public.mail_subscriptions
for each row
execute function public.set_updated_at();

alter table public.mail_subscriptions enable row level security;

comment on table public.mail_subscriptions is
  'Provider change-notification subscriptions, one per shop, provider and folder. Created and renewed by agent/src/mail/subscription-manager.mjs only when MAIL_WEBHOOK_URL is set. A trigger, never the truth: a lost subscription costs latency, not mail.';

comment on column public.mail_subscriptions.client_state_hash is
  'sha256 of the clientState secret given to the provider at creation. The webhook hashes the clientState a notification carries and compares; the secret itself is never stored.';

comment on column public.mail_subscriptions.last_error is
  'The last create or renew failure, one line. Paired with an error-level log (mail.subscription_renew_failed): the alert, until the project has an alert channel.';

-- ============================================================================
-- 76 — THE STOREFRONT ADVISOR'S CONVERSATIONS
--
-- WHAT THIS ADDS.
--   `storefront_chat_sessions` — one anonymous conversation in the storefront
--     widget. `session_token` is what the browser holds (minted HERE, never
--     chosen by the client); `shop_domain` is the *.myshopify.com domain the
--     app proxy signed for. `turn_count` counts customer messages and is what
--     the per-session cap reads.
--   `storefront_chat_messages` — each customer message and each reply, with
--     the page context the widget sent (page type, product / collection
--     handle, locale, path). Never a customer id, never an order.
--   Three functions, service role only: the shop's customer-message count
--     since a time (the daily cap), the turn bookkeeping, and the retention
--     purge.
--
-- NOT `chat_*`. Those names belong to the management chat (migration 17), a
-- different audience on a different trust boundary.
--
-- NO FOREIGN KEY TO `shops`. The widget runs on a dev store that has no `shops`
-- row — the dashboard is single-shop — and the proxy signature, not a join,
-- is what proves which store a session came from.
--
-- RETENTION. Customers can type an email address or an order number unasked,
-- so sessions are purged after `STOREFRONT_CHAT_RETENTION_DAYS` of inactivity
-- (`storefront_chat_purge`); messages go with them.
--
-- IDEMPOTENT: `if not exists` and `create or replace`. No data is written.
--
-- Requires: nothing beyond pgcrypto's gen_random_uuid (01_foundation.sql).
-- ============================================================================

create table if not exists public.storefront_chat_sessions (
  id uuid primary key default gen_random_uuid(),
  session_token uuid not null default gen_random_uuid(),
  shop_domain text not null,
  source text not null default 'storefront_embed',
  status text not null default 'active',
  -- The storefront language when the session opened (request.locale), e.g. `fr`.
  locale text,
  turn_count integer not null default 0,
  created_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),

  constraint storefront_chat_sessions_token_unique unique (session_token),
  constraint storefront_chat_sessions_source_check check (source in ('storefront_embed')),
  constraint storefront_chat_sessions_status_check check (status in ('active', 'closed')),
  constraint storefront_chat_sessions_turn_count_check check (turn_count >= 0)
);

create index if not exists storefront_chat_sessions_shop_idx
  on public.storefront_chat_sessions (shop_domain, created_at desc);
create index if not exists storefront_chat_sessions_activity_idx
  on public.storefront_chat_sessions (last_activity_at);

alter table public.storefront_chat_sessions enable row level security;
revoke all on public.storefront_chat_sessions from anon, authenticated;

comment on table public.storefront_chat_sessions is
  'An anonymous storefront advisor conversation (Theme App Extension via app proxy). The token is minted server-side; purged after the retention window.';

create table if not exists public.storefront_chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.storefront_chat_sessions(id) on delete cascade,
  role text not null,
  content text not null,
  -- The quick action that sent it (find_product, build_routine, ...), customer messages only.
  action text,
  -- Page type, product / collection handle, locale, path. Never customer data.
  context jsonb not null default '{}'::jsonb,
  -- Null for the mock responder; the model id once an LLM answers.
  model text,
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz not null default now(),

  constraint storefront_chat_messages_role_check check (role in ('user', 'assistant')),
  constraint storefront_chat_messages_content_check check (char_length(content) between 1 and 8000)
);

create index if not exists storefront_chat_messages_session_idx
  on public.storefront_chat_messages (session_id, created_at);
create index if not exists storefront_chat_messages_created_idx
  on public.storefront_chat_messages (created_at);

alter table public.storefront_chat_messages enable row level security;
revoke all on public.storefront_chat_messages from anon, authenticated;

comment on table public.storefront_chat_messages is
  'Each customer message and advisor reply in a storefront_chat_sessions conversation, with the page context the widget sent.';

-- The daily cap: customer messages for one shop since a time.
create or replace function public.storefront_chat_user_messages_since(p_shop_domain text, p_since timestamptz)
returns integer
language sql
stable
set search_path = ''
as $$
  select count(*)::integer
  from public.storefront_chat_messages m
  join public.storefront_chat_sessions s on s.id = m.session_id
  where s.shop_domain = p_shop_domain
    and m.role = 'user'
    and m.created_at >= p_since;
$$;

-- One customer turn happened: count it and move the activity clock, atomically.
create or replace function public.storefront_chat_record_turn(p_session uuid)
returns integer
language sql
set search_path = ''
as $$
  update public.storefront_chat_sessions s
  set turn_count = s.turn_count + 1,
      last_activity_at = now()
  where s.id = p_session
  returning s.turn_count;
$$;

-- Retention: every session idle since before `p_before` goes, messages with it.
create or replace function public.storefront_chat_purge(p_before timestamptz)
returns integer
language sql
set search_path = ''
as $$
  with gone as (
    delete from public.storefront_chat_sessions s
    where s.last_activity_at < p_before
    returning 1
  )
  select count(*)::integer from gone;
$$;

revoke all on function public.storefront_chat_user_messages_since(text, timestamptz) from public, anon, authenticated;
revoke all on function public.storefront_chat_record_turn(uuid) from public, anon, authenticated;
revoke all on function public.storefront_chat_purge(timestamptz) from public, anon, authenticated;
grant execute on function public.storefront_chat_user_messages_since(text, timestamptz) to service_role;
grant execute on function public.storefront_chat_record_turn(uuid) to service_role;
grant execute on function public.storefront_chat_purge(timestamptz) to service_role;

-- ============================================================================
-- 89 — SOCIAL AUDIENCE: A DATED MANUAL DISTRIBUTION PER PLATFORM AND DIMENSION
--
-- WHAT THIS ADDS. `social_audience_manual` — the latest percentage distribution
--   a person entered for gender, age, countries or cities of one platform,
--   with its observation date. One row per shop / platform / dimension: a new
--   entry replaces the old one, no history. Provider snapshots
--   (`social_audience`) stay separate and win for a whole dimension.
--   Partial distributions stay partial: nothing is rescaled to 100.
--
-- IDEMPOTENT. Requires: 70_social.sql.
-- ============================================================================

create or replace function public.valid_manual_audience(p_dimension text, p_entries jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  item jsonb;
  label text;
  amount numeric;
  total numeric := 0;
  labels text[] := '{}';
begin
  if p_dimension not in ('gender', 'age', 'country', 'city') or jsonb_typeof(p_entries) <> 'array' then return false; end if;
  if jsonb_array_length(p_entries) not between 1 and 50 then return false; end if;
  for item in select value from jsonb_array_elements(p_entries) loop
    label := item->>'key';
    if jsonb_typeof(item->'key') <> 'string' or label is null or length(trim(label)) not between 1 and 80 or label ~ '[[:cntrl:]]' or lower(trim(label)) = any(labels)
       or (p_dimension = 'gender' and label not in ('female', 'male', 'unknown')) or jsonb_typeof(item->'value') <> 'number' then return false; end if;
    amount := (item->>'value')::numeric;
    if amount is null or amount < 0 or amount > 100 then return false; end if;
    total := total + amount;
    labels := array_append(labels, lower(trim(label)));
  end loop;
  return total <= 100;
exception when others then
  return false;
end;
$$;

create table if not exists public.social_audience_manual (
  shop_id uuid not null references public.shops(id) on delete cascade,
  kind text not null check (kind in ('instagram', 'facebook', 'tiktok')),
  dimension text not null check (dimension in ('gender', 'age', 'country', 'city')),
  captured_on date not null check (captured_on >= '2000-01-01'),
  entries jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (shop_id, kind, dimension),
  check (public.valid_manual_audience(dimension, entries))
);

alter table public.social_audience_manual enable row level security;
revoke all on public.social_audience_manual from anon, authenticated;

comment on table public.social_audience_manual is
  'The latest dated, person-entered percentage distribution per shop / platform / dimension. Provider audience snapshots remain separate and take precedence for a whole dimension.';

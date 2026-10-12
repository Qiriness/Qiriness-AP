-- ============================================================================
-- 94 — CARRIER NAMES FOLD BY DATA, NOT BY CODE
--
-- WHY. normalise_carrier() folded free-text carrier names with a CASE that
--   named this business's carriers (COLISSIMO, LA POSTE, CHRONOPOST, MONDIAL
--   RELAY …). Another business ships with other carriers and would have had to
--   edit SQL. The folding is configuration, so it is now rows: public.carrier_
--   aliases, seeded with exactly the rules the CASE held, so today's output is
--   unchanged (checked against all 12 distinct carrier names in production,
--   2026-10-12, by 94_carrier_aliases.test.mjs and on PGlite).
--
-- HOW IT MATCHES. A raw name takes the canonical name of the FIRST alias (by
--   position) whose pattern it contains, case-insensitively; otherwise it is
--   upper-cased and trimmed, as before. strpos, not LIKE, so a pattern holding
--   % or _ is matched literally.
--
-- WHY SECURITY DEFINER. The management chat's role calls this function through
--   chat.fulfilment_timing (a view checks tables as its owner but function calls
--   as the querying role), and that role cannot read public tables. The function
--   takes one text value, returns one text value, and pins its search_path, so
--   running it as its owner exposes nothing but the canonical name.
--
-- IMMUTABLE -> STABLE. It now reads a table. No index or generated column uses
--   it (checked), so nothing depends on immutability.
--
-- IDEMPOTENT. Requires: 06_analytics.sql, 17_management_chat.sql.
-- ============================================================================

create table if not exists public.carrier_aliases (
  id uuid primary key default gen_random_uuid(),
  pattern text not null,
  canonical text not null,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  constraint carrier_aliases_pattern_unique unique (pattern),
  constraint carrier_aliases_shape_check check (btrim(pattern) <> '' and btrim(canonical) <> '')
);

alter table public.carrier_aliases enable row level security;

comment on table public.carrier_aliases is
  'How free-text carrier names from fulfilment records fold into one canonical name: the first alias (by position) whose pattern the raw name contains, case-insensitively, wins; no match keeps the name, upper-cased. Configuration per deployment: edit rows, not SQL. Read by normalise_carrier().';
comment on column public.carrier_aliases.pattern is
  'Matched as a case-insensitive substring of the raw carrier name (strpos, so % and _ are literal).';
comment on column public.carrier_aliases.position is
  'Order of evaluation, lowest first. Matters where one raw name contains two patterns.';

-- The rules the CASE held, in its order. ON CONFLICT keeps an edited row.
insert into public.carrier_aliases (pattern, canonical, position) values
  ('COLISSIMO', 'COLISSIMO', 10),
  ('LA POSTE', 'COLISSIMO', 20),
  ('GLS', 'GLS', 30),
  ('CHRONOPOST', 'CHRONOPOST', 40),
  ('MONDIAL', 'MONDIAL RELAY', 50),
  ('DHL', 'DHL', 60),
  ('UPS', 'UPS', 70)
on conflict (pattern) do nothing;

create or replace function public.normalise_carrier(value text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when value is null or btrim(value) = '' then null
    else coalesce(
      (
        select a.canonical
        from public.carrier_aliases a
        where strpos(upper(value), upper(a.pattern)) > 0
        order by a.position, a.pattern
        limit 1
      ),
      upper(btrim(value))
    )
  end;
$$;

comment on function public.normalise_carrier(text) is
  'Free-text carrier name from a fulfilment record -> one canonical name, by the rows of public.carrier_aliases (first match by position; otherwise upper-cased). Without it one carrier stored three ways reports as three.';

revoke all on function public.normalise_carrier(text) from public, anon, authenticated;
grant execute on function public.normalise_carrier(text) to service_role;
grant execute on function public.normalise_carrier(text) to mgmt_chat_ro;

comment on column chat.fulfilment_timing.carrier is
  'Carrier of the first shipment: one canonical upper-case name per carrier, however the fulfilment feed spelled it.';

-- ============================================================================
-- 09 — WHO THE ROUTINES WERE BUILT FOR
--
-- WHAT THIS ADDS.
--   `storefront_agent_routine_profile` — the answers of the personalised
--     routines the builder provided in a window (`advisor_routines`), counted
--     per answer: the main concern (the question-1 button), the skin type, the
--     age range and the routine wanted (day / night / both). A null answer is
--     its own row (code null): the eye routine asks its eye concern instead of
--     the skin type, and an older routine may predate a question.
--   With it, the names the shop gave those answers, from its active advisor
--     knowledge (`advisor_knowledge.routines`): the main concerns', the skin
--     types', the age ranges' and the routine times' labels, in every language
--     the Rules tab has. The dashboard names the codes with them; a code with no
--     label is shown as the code.
--
-- Read-only, anonymous like the table: codes and counts, no customer.
--
-- Requires: 98_advisor_routines.sql, 97_advisor_knowledge.sql. Idempotent.
-- ============================================================================

create or replace function public.storefront_agent_routine_profile(
  p_shops text[],
  p_from timestamp without time zone,
  p_to timestamp without time zone,
  p_tz text
)
returns jsonb
language sql
stable
set search_path = public
as $$
with bounds as (
  select (p_from at time zone p_tz) as t0, (p_to at time zone p_tz) as t1
),
routines as (
  select r.*
  from advisor_routines r, bounds b
  where r.shop_domain = any(p_shops) and r.created_at >= b.t0 and r.created_at < b.t1
),
answers as (
  select 'main_concern' as field, main_concern as code from routines
  union all select 'skin_type', skin_type from routines
  union all select 'age_band', age_band from routines
  union all select 'routine_time', routine_time from routines
),
counted as (
  select field, jsonb_agg(jsonb_build_object('code', code, 'routines', n) order by n desc, code nulls last) as rows
  from (select field, code, count(*) as n from answers group by field, code) c
  group by field
),
knowledge as (
  select k.routines
  from advisor_knowledge k
  join shops s on s.id = k.shop_id
  where s.shop_domain = any(p_shops) and k.status = 'active'
  order by k.version desc
  limit 1
)
select jsonb_build_object(
  'total', (select count(*) from routines),
  'main_concern', coalesce((select rows from counted where field = 'main_concern'), '[]'::jsonb),
  'skin_type', coalesce((select rows from counted where field = 'skin_type'), '[]'::jsonb),
  'age_band', coalesce((select rows from counted where field = 'age_band'), '[]'::jsonb),
  'routine_time', coalesce((select rows from counted where field = 'routine_time'), '[]'::jsonb),
  'labels', coalesce((
    select jsonb_build_object(
      'main', coalesce(routines -> 'labels' -> 'main', '{}'::jsonb),
      'skin', coalesce(routines -> 'labels' -> 'skin', '{}'::jsonb),
      'age_ranges', coalesce(routines -> 'age_ranges', '[]'::jsonb),
      'routine_times', coalesce(routines -> 'routine_times', '[]'::jsonb)
    )
    from knowledge
  ), '{}'::jsonb)
);
$$;

revoke all on function public.storefront_agent_routine_profile(text[], timestamp without time zone, timestamp without time zone, text) from public, anon, authenticated;
grant execute on function public.storefront_agent_routine_profile(text[], timestamp without time zone, timestamp without time zone, text) to service_role;

comment on function public.storefront_agent_routine_profile(text[], timestamp without time zone, timestamp without time zone, text) is
  'The answers of the personalised routines provided over [p_from, p_to) as wall-clock time in p_tz, for the advisor''s shops: counts per main concern, skin type, age range and routine time (a null answer is its own row), with the labels of the shop''s active advisor knowledge. One jsonb document.';

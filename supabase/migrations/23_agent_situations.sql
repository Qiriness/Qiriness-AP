-- 23_agent_situations.sql
--
-- The AI agent panel's "How situations are picked" card:
-- insights_agent_situations(), one row counting how each investigated ticket got
-- its situation. Copied byte-for-byte from 06_analytics.sql
-- (23_agent_situations.test.mjs asserts it). A new function, so nothing is
-- dropped; `create or replace` makes a second apply a no-op. No table, no data.

-- -------------------------------------------------------- agent: situations

-- How the investigation picked a situation, per ticket: its LATEST run among
-- the runs made in the range, so a re-investigated ticket is counted once, as
-- it stands. Read from `ticket_investigations.exemplar_match`, where the
-- verdict stays what the embedding said and `chosen_by` / `resolved_from` /
-- `chooser` say who supplied the key (DECISIONS.md § "A near miss is settled by
-- a model"). The buckets partition the tickets:
--   matched            the matcher committed (score 0.65+)
--   tie_by_rules       a tie the rules made free to settle (`resolved_from`)
--   chosen_by_model    a near miss or tie the situation chooser settled
--   near_chooser_none  a near miss or tie the chooser was asked and said none
--   near_not_settled   a near miss or tie with no key and no "none": not asked
--                      (chooser off, our own side, run before it shipped) or failed
--   no_match           nothing scored close enough to choose between
--   not_recorded       no verdict: the matcher failed or was not wired
-- Always one row.
create or replace function public.insights_agent_situations(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text
)
returns table (
  tickets bigint,
  matched bigint,
  tie_by_rules bigint,
  chosen_by_model bigint,
  near_chooser_none bigint,
  near_not_settled bigint,
  no_match bigint,
  not_recorded bigint
)
language sql
stable
set search_path = public
as $$
  with latest as (
    select distinct on (i.ticket_id)
      i.exemplar_match as m
    from public.ticket_investigations i
    where i.shop_id = p_shop
      and i.created_at >= (p_from at time zone p_tz)
      and i.created_at < (p_to at time zone p_tz)
    order by i.ticket_id, i.created_at desc
  )
  select
    count(*),
    count(*) filter (where m->>'verdict' = 'matched'),
    count(*) filter (
      where m->>'verdict' = 'ambiguous'
        and m->>'exemplar_key' is not null
        and m->>'chosen_by' is distinct from 'model'
    ),
    count(*) filter (where m->>'verdict' in ('near', 'ambiguous') and m->>'chosen_by' = 'model'),
    count(*) filter (
      where m->>'verdict' in ('near', 'ambiguous')
        and m->>'exemplar_key' is null
        and m->'chooser'->>'choice' = 'none'
    ),
    count(*) filter (
      where m->>'verdict' in ('near', 'ambiguous')
        and m->>'exemplar_key' is null
        and coalesce(m->'chooser'->>'choice', '') <> 'none'
    ),
    count(*) filter (where m->>'verdict' = 'none'),
    count(*) filter (
      where m->>'verdict' is null
        or m->>'verdict' not in ('matched', 'near', 'ambiguous', 'none')
    )
  from latest;
$$;

revoke all on function public.insights_agent_situations from public, anon, authenticated;
grant execute on function public.insights_agent_situations to service_role;

comment on function public.insights_agent_situations is
  'How each ticket investigated in a date range got its situation (latest run per ticket): matched, tie settled by rules, near miss chosen by the model, chooser said none, not settled, no match, not recorded. Always one row.';

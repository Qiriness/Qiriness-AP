-- ============================================================================
-- 51 — A SWITCH PER DESTINATION
--
-- `forwarding_destinations.active_since`: null is off; otherwise the moment the
-- destination was switched on, and it receives only mail received from then.
-- Until now clearing the address was the off switch, which lost the address
-- and — worse — switching back on would have delivered everything that arrived
-- meanwhile, since none of it had been forwarded.
--
-- THE ONE DATA STATEMENT: destinations that have an address today were « on »
-- under the old rule, so they are switched on now. Global forwarding
-- (`forwarding_settings.forward_since`) is still off, so this sends nothing.
-- Re-running it touches nothing: it only fills rows still null with an address,
-- and after the first run there are none it has not already set.
--
-- COPIED FROM 04_support.sql (51_destination_switch.test.mjs asserts the two
-- agree). IDEMPOTENT.
--
-- Requires: 49_forwarding_destinations.sql.
-- ============================================================================

alter table public.forwarding_destinations
  add column if not exists active_since timestamptz;

comment on column public.forwarding_destinations.active_since is
  'The destination''s switch. Null is off. Otherwise the moment it was switched on: only mail received from then on is forwarded to it, so switching it back on never delivers what arrived while it was off. Needs an address to be on.';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'forwarding_destinations_active_needs_address_check'
  ) then
    update public.forwarding_destinations
      set active_since = now()
      where active_since is null and forward_email is not null;
    alter table public.forwarding_destinations
      add constraint forwarding_destinations_active_needs_address_check check (
        active_since is null or forward_email is not null
      );
  end if;
end $$;

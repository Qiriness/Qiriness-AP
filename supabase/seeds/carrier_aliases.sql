-- ============================================================================
-- SEED — CARRIER ALIASES (how free-text carrier names fold into one)
--
-- The rules production started with (migration 94), for a French-shipping shop:
-- COLISSIMO / LA POSTE, GLS, CHRONOPOST, MONDIAL RELAY, DHL, UPS. Another
-- business edits or replaces these rows; nothing in code names a carrier.
--
-- Safe to re-run (ON CONFLICT keeps an edited row). Not per shop: one set per
-- deployment. npm run db:apply:migration -- supabase/seeds/carrier_aliases.sql
-- ============================================================================

insert into public.carrier_aliases (pattern, canonical, position) values
  ('COLISSIMO', 'COLISSIMO', 10),
  ('LA POSTE', 'COLISSIMO', 20),
  ('GLS', 'GLS', 30),
  ('CHRONOPOST', 'CHRONOPOST', 40),
  ('MONDIAL', 'MONDIAL RELAY', 50),
  ('DHL', 'DHL', 60),
  ('UPS', 'UPS', 70)
on conflict (pattern) do nothing;

-- ============================================================================
-- SEED — ISSUE FAMILIES (case linking configuration), per shop
--
-- Which subjects and situations belong to one customer problem, and which
-- family may follow which. Read by the case `link` pass; without these rows no
-- two threads are ever linked on family grounds.
--
-- RUN AFTER A SHOP EXISTS (its first sync creates the shops row), and again for
-- any new shop: it inserts one set per shop and skips rows already there, so it
-- is safe to re-run. npm run db:apply:migration -- supabase/seeds/issue_families.sql
--
-- Moved verbatim from the archived 61_cases.sql (2026-10-13). As a migration it
-- seeded only the shops that existed when it ran — on a fresh database, none.
-- ============================================================================

insert into public.issue_family_members (shop_id, member_kind, member_key, family_key)
select s.id, v.kind, v.member, v.family
from public.shops s
cross join (values
  ('subject', 'delivery', 'DELIVERY'),
  ('subject', 'order', 'ORDER_CHANGE'),
  ('subject', 'return_exchange', 'REFUND_RETURN'),
  ('subject', 'payment', 'PAYMENT'),
  ('subject', 'promotions', 'PROMOTION'),
  ('subject', 'product', 'PRODUCT'),
  ('subject', 'product_stock', 'PRODUCT'),
  ('subject', 'account', 'ACCOUNT'),
  ('subject', 'cosmetovigilance', 'COSMETOVIGILANCE'),
  ('situation', 'D-01', 'DELIVERY'),
  ('situation', 'D-02', 'DELIVERY'),
  ('situation', 'D-03', 'DELIVERY'),
  ('situation', 'D-05', 'DELIVERY'),
  ('situation', 'D-06', 'DELIVERY'),
  ('situation', 'D-07', 'DELIVERY'),
  ('situation', 'D-08', 'DELIVERY'),
  ('situation', 'D-33', 'DELIVERY'),
  ('situation', 'D-36', 'DELIVERY'),
  ('situation', 'D-37', 'DELIVERY'),
  ('situation', 'O-09', 'DELIVERY'),
  ('situation', 'O-12', 'ORDER_CHANGE'),
  ('situation', 'O-13', 'ORDER_CHANGE'),
  ('situation', 'O-14', 'ORDER_CHANGE'),
  ('situation', 'P-15', 'PROMOTION'),
  ('situation', 'P-17', 'PROMOTION'),
  ('situation', 'P-18', 'PROMOTION'),
  ('situation', 'P-19', 'PROMOTION'),
  ('situation', 'P-20', 'DELIVERY'),
  ('situation', 'P-21', 'PROMOTION'),
  ('situation', 'P-22', 'PROMOTION'),
  ('situation', 'R-21', 'REFUND_RETURN'),
  ('situation', 'R-22', 'REFUND_RETURN'),
  ('situation', 'R-23', 'REFUND_RETURN'),
  ('situation', 'PR-24', 'PRODUCT'),
  ('situation', 'PR-25', 'PRODUCT'),
  ('situation', 'PR-26', 'PRODUCT'),
  ('situation', 'PR-27', 'PRODUCT'),
  ('situation', 'PR-28', 'PRODUCT'),
  ('situation', 'PR-29', 'PRODUCT'),
  ('situation', 'S-34', 'PRODUCT'),
  ('situation', 'A-29', 'ACCOUNT'),
  ('situation', 'A-35', 'ACCOUNT'),
  ('situation', 'PA-30', 'PAYMENT'),
  ('situation', 'PA-31', 'PAYMENT'),
  ('situation', 'PA-32', 'PAYMENT'),
  ('situation', 'CV-01', 'COSMETOVIGILANCE'),
  ('situation', 'CV-02', 'COSMETOVIGILANCE'),
  ('situation', 'CV-03', 'COSMETOVIGILANCE'),
  ('situation', 'CV-04', 'COSMETOVIGILANCE')
) as v(kind, member, family)
on conflict (shop_id, member_kind, member_key) do nothing;

insert into public.issue_family_transitions (shop_id, from_family, to_family)
select s.id, v.from_family, v.to_family
from public.shops s
cross join (values
  ('ORDER_CHANGE', 'DELIVERY'),
  ('DELIVERY', 'ORDER_CHANGE'),
  ('DELIVERY', 'REFUND_RETURN'),
  ('ORDER_CHANGE', 'REFUND_RETURN'),
  ('PAYMENT', 'ORDER_CHANGE'),
  ('ORDER_CHANGE', 'PAYMENT')
) as v(from_family, to_family)
on conflict (shop_id, from_family, to_family) do nothing;

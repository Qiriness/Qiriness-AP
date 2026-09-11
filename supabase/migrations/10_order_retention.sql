-- ============================================================================
-- 10 — ORDER RETENTION BECOMES A SETTING
--
-- WHAT THIS CHANGES. How long orders are kept stops being a constant in code and
-- becomes a switch on the shop: a number of months, or indefinite. This shop is
-- set to indefinite, which is why the deletion dates are cleared below.
--
-- WHY THE RULE NAMES LOSE THEIR DURATIONS. `retention_rule` said both why the
-- clock started and how long it ran — `delivered_plus_3_months` — enumerated in
-- a check constraint and compared literally in `deriveOrderStatus`. A period
-- that appears in an enum cannot be a setting: every new window multiplies the
-- list and needs a matching branch in code that only ever cared WHY. The rule
-- now names the reason; the period lives on `shops` and arrives applied, as
-- `retention_delete_after`.
--
-- THIS ALSO RECONCILES A DRIFT. Before this migration the live constraint
-- allowed `delivered_plus_6_months` and `return_refund_completed_plus_6_months`,
-- which appear in no file in this repo — the 3→6 month change was applied
-- directly to the database and never written down, while the mapper carried on
-- emitting `delivered_plus_3_months`, a value that constraint would refuse. It
-- had not failed yet only because `delivered_at` is almost always null on this
-- shop. Both vocabularies are mapped below, so this applies cleanly whichever
-- one a database happens to be holding.
--
-- IDEMPOTENT, and applies to a fresh baseline as well as to the live database:
-- 01 and 02 already declare the end state, so on a new install every statement
-- here is a no-op.
--
-- Requires: 01_foundation.sql (shops), 02_shopify.sql (orders).
-- ============================================================================

-- ------------------------------------------------------------ the switch

alter table public.shops
  add column if not exists order_retention_mode text not null default 'months',
  add column if not exists order_retention_months integer default 6,
  add column if not exists order_retention_changed_at timestamptz,
  add column if not exists order_retention_reason text;

alter table public.shops drop constraint if exists shops_order_retention_check;

alter table public.shops
  add constraint shops_order_retention_check check (
    (order_retention_mode = 'months' and order_retention_months is not null and order_retention_months > 0)
    or (order_retention_mode = 'indefinite' and order_retention_months is null)
  );

comment on column public.shops.order_retention_mode is
  'How long orders are kept: months (with order_retention_months) or indefinite (with none). Read by scripts/lib/order-retention.mjs. Deliberately not a support_parameters row -- there a null value means "nobody has decided yet", and indefinite retention of personal data must never be reachable by leaving a field blank.';

comment on column public.shops.order_retention_months is
  'The retention period in months when order_retention_mode is months. Must be null when the mode is indefinite, so the setting has exactly one reading.';

comment on column public.shops.order_retention_reason is
  'Why the retention period was last changed. Retention is a compliance control and the live constraint has already drifted from this repo once; a change with no recorded reason is how that happened.';

-- ------------------------------------------------------------ reason-only rules

-- ORDER MATTERS IN BOTH DIRECTIONS, and getting it half right fails loudly:
--   drop   -- the OLD constraint refuses the new names ('delivered' is not
--            'delivered_plus_6_months'), so the update cannot run under it
--   update -- rewrite every existing row to the reason-only vocabulary
--   add    -- the NEW constraint refuses the old names, so it cannot precede
--            the update either
-- The first attempt at this migration ran update before drop and was rejected
-- with `new row for relation "orders" violates check constraint`.
alter table public.orders drop constraint if exists orders_retention_rule_check;

update public.orders
   set retention_rule = case
     when retention_rule like 'delivered%' then 'delivered'
     when retention_rule like 'undelivered%' then 'undelivered'
     when retention_rule like 'return_refund_completed%' then 'return_refund_completed'
     when retention_rule like 'return_refund_open%' then 'return_refund_open'
     else retention_rule
   end
 where retention_rule is not null
   and retention_rule not in ('delivered', 'undelivered', 'return_refund_completed', 'return_refund_open');

alter table public.orders
  add constraint orders_retention_rule_check check (
    retention_rule is null
      or retention_rule in (
        'delivered',
        'undelivered',
        'return_refund_completed',
        'return_refund_open'
      )
  );

comment on column public.orders.retention_rule is
  'WHY the retention clock started, not how long it runs: delivered, undelivered, return_refund_completed, or return_refund_open. The period is the shop setting (shops.order_retention_mode/_months) and arrives here already applied as retention_delete_after.';

comment on column public.orders.retention_delete_after is
  'Timestamp after which the local operational order snapshot can be deleted: the anchor named by retention_rule plus the shop retention period. NULL MEANS KEPT INDEFINITELY -- not a missing value. The purge selects rows whose date is at or before now, so a null is simply never matched and needs no special case in the delete path.';

-- ------------------------------------------------------------ this shop's choice

-- SET TO INDEFINITE, deliberately and by this migration rather than by hand, so
-- the setting and the repo agree from the start. Change it with an update to
-- these three columns together; the constraint above refuses an incoherent pair.
update public.shops
   set order_retention_mode = 'indefinite',
       order_retention_months = null,
       order_retention_changed_at = now(),
       order_retention_reason =
         'Order history is needed for analysis beyond the previous 3-6 month window. '
         'Set by migration 10; see DECISIONS.md "Retention".'
 where order_retention_mode is distinct from 'indefinite';

-- Existing rows were stamped under the old policy and would still be deleted on
-- the next sync -- 161 of them were already past their date when this was
-- written. Clearing the dates is what actually stops that; the sync also skips
-- the purge entirely while the mode is indefinite.
update public.orders o
   set retention_delete_after = null
  from public.shops s
 where o.shop_id = s.id
   and s.order_retention_mode = 'indefinite'
   and o.retention_delete_after is not null;

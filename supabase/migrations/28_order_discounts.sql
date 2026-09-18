-- ============================================================================
-- 28 — AN ORDER REMEMBERS WHICH PROMOTION WAS APPLIED, NOT ONLY HOW MUCH
--
-- WHAT THIS CHANGES. `orders` gains `discount_applications` and
-- `discount_codes`. The table already stored `total_discounts` — one number —
-- and support is asked a question that number cannot answer: « mon cadeau / ma
-- promotion a-t-il bien été appliqué ? ». Measured on the mailbox: order #6827
-- carries 20,90 € of discount, which is the gift « Sauna Visage offert » taking
-- one line to zero, and the investigation could only say that something worth
-- 20,90 € came off.
--
-- A GIFT AND A SAMPLE LOOK IDENTICAL WITHOUT THIS. Both are lines at 0,00 €:
-- 2,643 orders carry a zero-price line and only 1,126 carry a line whose price
-- was REDUCED to zero. The line's `discounts[]` (inside `line_items`, no schema
-- change) names the promotion that reduced it; a sample has none.
--
-- WHERE THE NAME COMES FROM. This shop runs AUTOMATIC promotions, so Shopify
-- returns an empty `discountCodes` and the name is the application's title.
-- A code-based order carries the typed code in both columns. `kind` keeps the
-- distinction without the GraphQL spelling.
--
-- NO DATA IS WRITTEN. Every existing row gets the empty default; the values
-- arrive when the orders are re-synced (`sync:shopify:orders -- --all-orders`).
-- The webhook path re-reads each order through the same query, so live orders
-- fill in without a second code path.
--
-- COPIED FROM 02_shopify.sql, NOT RETYPED (28_order_discounts.test.mjs asserts
-- the columns, the check and the comments are equal to the baseline's).
--
-- IDEMPOTENT: `add column if not exists`, the constraint dropped and re-added.
--
-- Requires: 02_shopify.sql.
-- ============================================================================

alter table public.orders
  add column if not exists discount_applications jsonb not null default '[]'::jsonb,
  add column if not exists discount_codes text[] not null default '{}';

alter table public.orders drop constraint if exists orders_discount_applications_array_check;

alter table public.orders
  add constraint orders_discount_applications_array_check check (
    jsonb_typeof(discount_applications) = 'array'
  );

comment on column public.orders.discount_applications is
  'One entry per promotion applied to this order, from Shopify discountApplications: kind (code/automatic/manual/script), name (the typed code, or the promotion title), percentage or amount, and what it targeted. Empty where none applied. Read by the agent to answer "was my promotion or gift applied?" by name rather than by amount.';

comment on column public.orders.discount_codes is
  'Discount codes typed on this order. Empty on automatic promotions, which is what this shop runs — the name then lives in discount_applications.';

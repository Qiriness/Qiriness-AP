-- ============================================================================
-- 29 — A SITUATION MAY REQUIRE "WAS THE PROMOTION APPLIED TO THIS ORDER?"
--
-- WHAT THIS CHANGES. `support_exemplars.requirement_needs` accepts one more
-- value, `order_promotion`. The evidence vocabulary gained it with the
-- `checkOrderPromotion` tool (28_order_discounts.sql carries the data it reads),
-- and a situation that cannot declare it would be scored against needs that do
-- not describe it.
--
-- WHY IT IS ITS OWN NEED. `payment_state` says whether we hold the customer's
-- money and `order_state` where the parcel is; neither answers « mon cadeau
-- a-t-il été appliqué ? ». Order #6827 is paid, dispatched and carries the gift;
-- #6913 is paid, dispatched and carries nothing — the same two states, opposite
-- replies.
--
-- NO DATA IS WRITTEN and nothing existing is invalidated: the check only widens,
-- so every row that passed before passes now.
--
-- COPIED FROM 05_exemplars.sql, NOT RETYPED (29_order_promotion_need.test.mjs
-- asserts the two are equal).
--
-- IDEMPOTENT: the constraint is dropped and re-added.
--
-- Requires: 05_exemplars.sql.
-- ============================================================================

alter table public.support_exemplars
  drop constraint if exists support_exemplars_requirement_needs_check;

alter table public.support_exemplars
  add constraint support_exemplars_requirement_needs_check check (
    requirement_needs <@ array[
      'product_identity', 'product_property', 'product_availability', 'product_recommendation',
      'product_offer',
      'order_identity', 'order_state', 'order_promotion', 'delivery_state', 'dispatch_state', 'payment_state',
      'refund_state', 'return_eligibility', 'buyer_type',
      'promotion_identity', 'promotion_validity', 'promotion_eligibility',
      'customer_identity', 'customer_account_state', 'customer_history',
      'purchase_verified', 'photo_evidence', 'reaction_product',
      'policy_answer', 'brand_answer', 'checkout_state', 'other_fact'
    ]::text[]
  );

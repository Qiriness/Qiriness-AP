-- ============================================================================
-- 66 — A SITUATION MAY DECLARE WHETHER THE FREE ITEM IS IN STOCK NOW
--
-- WHAT THIS CHANGES. `support_exemplars.requirement_needs` accepts one more
-- value, `promotion_reward_stock`: whether the free item of an identified offer
-- (a gift, or the « +1 » of a 3+1) is in stock TODAY -- in_stock, partial,
-- out_of_stock, no_reward or unknown.
--
-- WHY. A gift missing from the order or the parcel is put right by sending it,
-- or by offering something in its place when it is gone. Which of the two is
-- decided by the stock at the time of the query, not at the order date, and
-- no rule could branch on it until now.
--
-- A WIDENING ONLY. No situation declares it yet; nothing is written. Rules can
-- already branch on it without this: their conditions decide what is scored.
--
-- COPIED FROM 05_exemplars.sql, NOT RETYPED (66_promotion_reward_stock_need.test.mjs
-- asserts the check equals the baseline's and the code vocabulary).
--
-- IDEMPOTENT: the constraint is dropped if present and re-added.
--
-- Requires: 05_exemplars.sql, 58_promotion_outcome_need.sql.
-- ============================================================================

alter table public.support_exemplars
  drop constraint if exists support_exemplars_requirement_needs_check;

alter table public.support_exemplars
  add constraint support_exemplars_requirement_needs_check check (
    requirement_needs <@ array[
      'product_identity', 'product_property', 'product_availability', 'product_recommendation',
      'product_offer',
      'order_identity', 'order_state', 'order_promotion', 'delivery_state', 'dispatch_state',
      'delivery_delay_state', 'payment_state',
      'refund_state', 'return_eligibility', 'buyer_type',
      'promotion_identity', 'promotion_validity', 'promotion_eligibility', 'promotion_outcome',
      'promotion_reward_stock',
      'customer_identity', 'customer_account_state', 'customer_history',
      'purchase_verified', 'photo_evidence', 'reaction_product',
      'brand_answer', 'policy_attached', 'checkout_state', 'other_fact'
    ]::text[]
  );

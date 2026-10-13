-- ============================================================================
-- 67 — A SITUATION MAY DECLARE WHETHER THE ORDER'S SAMPLES ARE IN STOCK NOW
--
-- WHAT THIS CHANGES. `support_exemplars.requirement_needs` accepts one more
-- value, `sample_stock`: whether the samples on the ticket's order (lines
-- never priced) are in stock TODAY -- in_stock, partial, out_of_stock,
-- no_samples or unknown.
--
-- WHY. P-20 « je n'ai pas reçu mes échantillons » is put right by sending the
-- samples again, which depends on their stock now. Samples are order lines
-- with a product id and tracked stock (measured 2026-10-04: 722 sample lines
-- on 287 of 754 orders over 90 days, 7 products, all stock-tracked).
--
-- A WIDENING ONLY. No situation declares it yet; nothing is written.
--
-- COPIED FROM 05_exemplars.sql, NOT RETYPED (67_sample_stock_need.test.mjs
-- asserts the check equals the baseline's and the code vocabulary).
--
-- IDEMPOTENT: the constraint is dropped if present and re-added.
--
-- Requires: 05_exemplars.sql, 66_promotion_reward_stock_need.sql.
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
      'promotion_reward_stock', 'sample_stock',
      'customer_identity', 'customer_account_state', 'customer_history',
      'purchase_verified', 'photo_evidence', 'reaction_product',
      'brand_answer', 'policy_attached', 'checkout_state', 'other_fact'
    ]::text[]
  );

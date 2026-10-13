-- ============================================================================
-- 58 — A SITUATION MAY DECLARE WHY A PROMOTION DID OR DID NOT APPLY
--
-- WHAT THIS CHANGES. `support_exemplars.requirement_needs` accepts one more
-- value, `promotion_outcome`: whether an identified promotion applied to the
-- order or the last abandoned basket, and if not, why -- expired, outside the
-- delivery countries, not combinable, no qualifying item, below the threshold,
-- reward not in the basket, or every condition met (a person looks).
--
-- WHY. Measured 2026-10-01: about as many complaints are about AUTOMATIC
-- offers as about codes -- free shipping charged on 72 EUR, the gift « dès
-- 65 € » charged, 3 masks ordered and no 4th -- and their answer is none of
-- the code checks `promotion_eligibility` names.
--
-- A WIDENING ONLY. No situation declares it yet; nothing is written.
--
-- COPIED FROM 05_exemplars.sql, NOT RETYPED (58_promotion_outcome_need.test.mjs
-- asserts the check equals the baseline's and the code vocabulary).
--
-- IDEMPOTENT: the constraint is dropped if present and re-added.
--
-- Requires: 05_exemplars.sql, 56_policy_search_retired.sql.
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
      'customer_identity', 'customer_account_state', 'customer_history',
      'purchase_verified', 'photo_evidence', 'reaction_product',
      'brand_answer', 'policy_attached', 'checkout_state', 'other_fact'
    ]::text[]
  );

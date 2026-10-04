-- ============================================================================
-- 68 — A SITUATION MAY DECLARE WHETHER THE ORDER'S GIFTS ARE IN STOCK NOW
--
-- WHAT THIS CHANGES. `support_exemplars.requirement_needs` accepts one more
-- value, `order_gift_stock`: whether the gifts on the ticket's order (lines a
-- promotion reduced to zero) are in stock TODAY -- in_stock, partial,
-- out_of_stock, no_gifts or unknown.
--
-- WHY. P-20 is « je n'ai pas reçu les échantillons OU LE CADEAU ». 67 covered
-- the samples; a gift missing from the parcel is resent on the same terms, and
-- answering it with the samples' stock would offer to resend the wrong item.
--
-- A WIDENING ONLY. No situation declares it yet; nothing is written.
--
-- COPIED FROM 05_exemplars.sql, NOT RETYPED (68_order_gift_stock_need.test.mjs
-- asserts the check equals the baseline's and the code vocabulary).
--
-- IDEMPOTENT: the constraint is dropped if present and re-added.
--
-- Requires: 05_exemplars.sql, 67_sample_stock_need.sql.
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
      'promotion_reward_stock', 'sample_stock', 'order_gift_stock',
      'customer_identity', 'customer_account_state', 'customer_history',
      'purchase_verified', 'photo_evidence', 'reaction_product',
      'brand_answer', 'policy_attached', 'checkout_state', 'other_fact'
    ]::text[]
  );

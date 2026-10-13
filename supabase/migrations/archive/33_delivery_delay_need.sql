-- ============================================================================
-- 33 — A SITUATION MAY REQUIRE "HAS DELIVERY RUN LONGER THAN IT USUALLY DOES?"
--
-- WHAT THIS CHANGES. `support_exemplars.requirement_needs` accepts one more
-- value, `delivery_delay_state`. The evidence vocabulary gained it with the
-- second delivery window (`france_delivery_days` against `abroad_delivery_days`,
-- both in 09_parameters.sql), and a situation that cannot declare it would be
-- scored against needs that do not describe it.
--
-- WHY IT IS ITS OWN NEED AND NOT A VALUE OF `delivery_state`. That one says the
-- parcel left and nothing has scanned it since — true of 99% of shipped orders,
-- and just as true on day two as on day twenty. This says whether the wait has
-- run past what delivery usually takes. Folding it in as a fourth
-- `delivery_state` value would have done something worse than duplicate:
-- `expediee_sans_scan` branches on `dispatched_no_scan`, so a new value would
-- have silently stopped it matching the late case, and rewritten what every
-- stored investigation that recorded it means.
--
-- WHY TWO NUMBERS SIT BEHIND ONE STATE. Measured over the last 1 000 orders on
-- 2026-09-20: 881 to France, 119 elsewhere. A parcel that is late to Paris is
-- still on time to Milan, so one window would be wrong for 88% of orders in one
-- direction or 12% in the other.
--
-- NO DATA IS WRITTEN and nothing existing is invalidated: the check only widens,
-- so every row that passed before passes now.
--
-- COPIED FROM 05_exemplars.sql, NOT RETYPED (33_delivery_delay_need.test.mjs
-- asserts the two are equal). 29_order_promotion_need.sql did the same for
-- `order_promotion` and is now a step behind the baseline rather than equal to
-- it, which is what being a historical migration means.
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
      'order_identity', 'order_state', 'order_promotion', 'delivery_state', 'dispatch_state',
      'delivery_delay_state', 'payment_state',
      'refund_state', 'return_eligibility', 'buyer_type',
      'promotion_identity', 'promotion_validity', 'promotion_eligibility',
      'customer_identity', 'customer_account_state', 'customer_history',
      'purchase_verified', 'photo_evidence', 'reaction_product',
      'policy_answer', 'brand_answer', 'checkout_state', 'other_fact'
    ]::text[]
  );

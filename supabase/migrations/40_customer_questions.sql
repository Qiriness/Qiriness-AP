-- ============================================================================
-- 40 — FIVE MORE THINGS A RULE MAY ASK THE CUSTOMER
--
-- WHAT THIS CHANGES. `support_answers.ask` accepts five more keys:
-- postal_address, preferred_remedy, receipt_confirmation, skin_type,
-- skin_concern. `case-file.mjs` gained a label and a question for each on
-- 2026-09-26, after the multi-turn labelling kept meeting questions the desk
-- asks that no key could name.
--
-- NO DATA IS WRITTEN and nothing existing is invalidated: the check only
-- widens, so every row that passed before passes now.
--
-- COPIED FROM 05_exemplars.sql, NOT RETYPED (40_customer_questions.test.mjs
-- asserts the two are equal).
--
-- IDEMPOTENT: the constraint is dropped and re-added.
--
-- Requires: 05_exemplars.sql.
-- ============================================================================

alter table public.support_answers
  drop constraint if exists support_answers_ask_check;

alter table public.support_answers
  add constraint support_answers_ask_check check (
    ask <@ array[
      'shopify_order_number', 'purchase_email', 'product_name',
      'purchase_channel', 'photo', 'promotion_code', 'order_date_or_amount',
      'reaction_product_name', 'lot_number', 'account_email',
      'postal_address', 'preferred_remedy', 'receipt_confirmation',
      'skin_type', 'skin_concern'
    ]::text[]
  );

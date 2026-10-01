-- ============================================================================
-- 56 — POLICIES ARE READ BY KEY: THE SEARCH PATH AND THE CHECKLIST, RETIRED
--
-- Company policies (55) are read by key with getPolicy and linked to
-- situations. Two things that stood in for them go:
--
--   * `policy_answer`, the need « what an approved policy says » that the
--     investigation scored from a knowledge search. Removed from the need
--     vocabulary (agent/src/investigation/evidence-rules.mjs); here it is taken
--     out of the situations that declared it, then out of the check.
--   * and `policy_attached` joins the vocabulary: whether the situation's
--     linked policy reached the case (attached / not_attached), which the
--     policy-question rules branch on so a deleted policy has a fallback.
--   * the « Core setup » knowledge checklist: five slots on knowledge_documents
--     (order_policies, confidentiality, delivery_returns, locations, faqs), all
--     empty. Only `brand` (the Brand voice) remains.
--
-- DATA: one update, removing `policy_answer` from support_exemplars
-- .requirement_needs (20 situations on 2026-10-01). No article held one of the
-- five slots. COPIED FROM 03_knowledge.sql and 05_exemplars.sql
-- (56_policy_search_retired.test.mjs asserts they agree). IDEMPOTENT.
--
-- Requires: 03_knowledge.sql, 05_exemplars.sql, 33_delivery_delay_need.sql.
-- ============================================================================

update public.support_exemplars
  set requirement_needs = array_remove(requirement_needs, 'policy_answer')
  where 'policy_answer' = any(requirement_needs);

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
      'brand_answer', 'policy_attached', 'checkout_state', 'other_fact'
    ]::text[]
  );

alter table public.knowledge_documents
  drop constraint if exists knowledge_documents_core_topic_check;

alter table public.knowledge_documents
  add constraint knowledge_documents_core_topic_check check (
    core_topic is null or core_topic in (
      'brand'
    )
  );

comment on column public.knowledge_documents.core_topic is
  'The fixed slot this article fills: brand (the Brand voice) or null. At most one active article per shop per slot. Distinct from the category column. The other five slots were removed 2026-10-01 (56_policy_search_retired.sql).';

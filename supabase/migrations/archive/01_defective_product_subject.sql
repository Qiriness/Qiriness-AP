-- ============================================================================
-- 01 — A DEFECTIVE PRODUCT IS ITS OWN SUBJECT
--
-- WHAT THIS ADDS.
--   `defective_product` to the shared support taxonomy
--   (scripts/lib/support-taxonomy.mjs): a product the customer has that is
--   broken, leaking, opened on arrival, not working, or whose texture or smell
--   has changed. Every check constraint that mirrors the subject list is
--   widened; nothing is removed.
--
-- WHY (owner, 2026-11-06). Defects were filed `product`, beside advice
-- questions, so everything built for them had to tell the two apart some other
-- way: situation PR-38 by similarity, the « Produits défectueux » destination
-- by a description the router had to match. With a subject of their own, the
-- categoriser makes that call once and everything downstream reads it.
-- DECISIONS.md § A defective product is a subject, not a product problem.
--
-- THE DATA THAT FOLLOWS THE SUBJECT, all already about defects:
--   · situations PR-38 (broken or defective) and PR-26 (LED mask won't
--     charge) move to the new subject. Their rules stay in the `products`
--     answer set, which the code maps the new subject to, so no rule moves;
--   · a destination limited to `product` problems/complaints that matched on
--     its description (the defects destination) takes the new subject and
--     stops needing the description: the category now does that matching;
--   · issue families: the subject and both situations become family DEFECT,
--     which may follow DELIVERY (a parcel that arrived and then the product
--     inside is broken) and become REFUND_RETURN (a defect settled by a
--     refund). Only for shops already configured (those with a `product`
--     subject row); supabase/seeds/issue_families.sql seeds the same for new
--     shops.
--
-- TICKETS ARE NOT TOUCHED HERE. Existing tickets are relabelled by the
-- categoriser, not by SQL: agent `npm run tickets:relabel-subject -- --subject=defective_product`.
--
-- Requires: nothing. Idempotent.
-- ============================================================================

-- Fail fast rather than queue: the constraints lock `tickets`, and an ALTER
-- waiting behind the worker blocks every reader behind it (2026-10-30, orders).
set lock_timeout = '5s';

-- --- The subject vocabulary --------------------------------------------------

alter table public.tickets drop constraint if exists tickets_category_check;
alter table public.tickets add constraint tickets_category_check CHECK (((category IS NULL) OR (category = ANY (ARRAY['order'::text, 'delivery'::text, 'return_exchange'::text, 'product'::text, 'defective_product'::text, 'product_stock'::text, 'payment'::text, 'account'::text, 'promotions'::text, 'cosmetovigilance'::text, 'legal_privacy'::text, 'b2b'::text, 'partner_collaboration'::text, 'careers'::text, 'other'::text]))));

alter table public.tickets drop constraint if exists tickets_secondary_category_check;
alter table public.tickets add constraint tickets_secondary_category_check CHECK (((secondary_category IS NULL) OR (secondary_category = ANY (ARRAY['order'::text, 'delivery'::text, 'return_exchange'::text, 'product'::text, 'defective_product'::text, 'product_stock'::text, 'payment'::text, 'account'::text, 'promotions'::text, 'cosmetovigilance'::text, 'legal_privacy'::text, 'b2b'::text, 'partner_collaboration'::text, 'careers'::text, 'other'::text]))));

alter table public.support_exemplars drop constraint if exists support_exemplars_category_check;
alter table public.support_exemplars add constraint support_exemplars_category_check CHECK (((category IS NULL) OR (category = ANY (ARRAY['order'::text, 'delivery'::text, 'return_exchange'::text, 'product'::text, 'defective_product'::text, 'product_stock'::text, 'payment'::text, 'account'::text, 'promotions'::text, 'cosmetovigilance'::text, 'legal_privacy'::text, 'b2b'::text, 'partner_collaboration'::text, 'careers'::text, 'other'::text]))));

alter table public.knowledge_documents drop constraint if exists knowledge_documents_category_check;
alter table public.knowledge_documents add constraint knowledge_documents_category_check CHECK (((category IS NULL) OR (category = ANY (ARRAY['order'::text, 'delivery'::text, 'return_exchange'::text, 'product'::text, 'defective_product'::text, 'product_stock'::text, 'payment'::text, 'account'::text, 'promotions'::text, 'cosmetovigilance'::text, 'legal_privacy'::text, 'b2b'::text, 'partner_collaboration'::text, 'careers'::text, 'faq'::text, 'brand_story'::text]))));

alter table public.forwarding_destinations drop constraint if exists forwarding_destinations_categories_check;
alter table public.forwarding_destinations add constraint forwarding_destinations_categories_check CHECK (((cardinality(categories) > 0) AND (categories <@ ARRAY['order'::text, 'delivery'::text, 'return_exchange'::text, 'product'::text, 'defective_product'::text, 'product_stock'::text, 'payment'::text, 'account'::text, 'promotions'::text, 'cosmetovigilance'::text, 'legal_privacy'::text, 'b2b'::text, 'partner_collaboration'::text, 'careers'::text, 'other'::text])));

alter table public.category_forwarding drop constraint if exists category_forwarding_category_check;
alter table public.category_forwarding add constraint category_forwarding_category_check CHECK ((category = ANY (ARRAY['order'::text, 'delivery'::text, 'return_exchange'::text, 'product'::text, 'defective_product'::text, 'product_stock'::text, 'payment'::text, 'account'::text, 'promotions'::text, 'cosmetovigilance'::text, 'legal_privacy'::text, 'b2b'::text, 'partner_collaboration'::text, 'careers'::text, 'other'::text])));

alter table public.categorisation_review drop constraint if exists categorisation_review_agent_category_check;
alter table public.categorisation_review add constraint categorisation_review_agent_category_check CHECK (((agent_category IS NULL) OR (agent_category = ANY (ARRAY['order'::text, 'delivery'::text, 'return_exchange'::text, 'product'::text, 'defective_product'::text, 'product_stock'::text, 'payment'::text, 'account'::text, 'promotions'::text, 'cosmetovigilance'::text, 'legal_privacy'::text, 'b2b'::text, 'partner_collaboration'::text, 'careers'::text, 'other'::text]))));

alter table public.categorisation_review drop constraint if exists categorisation_review_human_category_check;
alter table public.categorisation_review add constraint categorisation_review_human_category_check CHECK (((human_category IS NULL) OR (human_category = ANY (ARRAY['order'::text, 'delivery'::text, 'return_exchange'::text, 'product'::text, 'defective_product'::text, 'product_stock'::text, 'payment'::text, 'account'::text, 'promotions'::text, 'cosmetovigilance'::text, 'legal_privacy'::text, 'b2b'::text, 'partner_collaboration'::text, 'careers'::text, 'other'::text]))));

-- The management chat reads this comment as the column's description.
comment on column chat.tickets.category is 'Subject: order, delivery, product (information and advice), defective_product (a product broken, leaking or not working), product_stock, return_exchange, promotions, payment, account, b2b, careers, partner_collaboration, legal_privacy, cosmetovigilance, other. Null when not yet categorised.';

comment on column public.tickets.category is 'Primary subject, from the shared support taxonomy in scripts/lib/support-taxonomy.mjs -- the same subjects knowledge articles use (all but other), so a ticket subject filters straight into the matching knowledge chunks. No subject implies a handling level on its own; cosmetovigilance floors at level 2 for a reported reaction (see the level comment).';

-- --- The data already about defects ------------------------------------------

update public.support_exemplars
set category = 'defective_product', updated_at = now()
where exemplar_key in ('PR-38', 'PR-26')
  and category = 'product';

update public.forwarding_destinations
set categories = array['defective_product'], match_description = false, updated_at = now()
where categories = array['product']
  and match_description
  and cardinality(request_kinds) > 0
  and request_kinds <@ array['problem', 'complaint'];

insert into public.issue_family_members (shop_id, member_kind, member_key, family_key)
select m.shop_id, v.kind, v.member, 'DEFECT'
from public.issue_family_members m
cross join (values
  ('subject', 'defective_product'),
  ('situation', 'PR-38'),
  ('situation', 'PR-26')
) as v(kind, member)
where m.member_kind = 'subject' and m.member_key = 'product'
on conflict (shop_id, member_kind, member_key) do update
  set family_key = excluded.family_key;

insert into public.issue_family_transitions (shop_id, from_family, to_family)
select m.shop_id, v.from_family, v.to_family
from public.issue_family_members m
cross join (values
  ('DELIVERY', 'DEFECT'),
  ('DEFECT', 'REFUND_RETURN')
) as v(from_family, to_family)
where m.member_kind = 'subject' and m.member_key = 'defective_product'
on conflict (shop_id, from_family, to_family) do nothing;

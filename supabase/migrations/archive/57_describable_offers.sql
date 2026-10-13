-- ============================================================================
-- 57 — AN AUTOMATIC OFFER MAY BE DESCRIBED TO A CUSTOMER UNLESS SOMEONE SAYS NO
--
-- WHAT THIS CHANGES. `promotions` gains `describable_in_replies`, default true.
-- It is the automatic-offer counterpart of `offerable_in_replies`, with the
-- opposite default because the risk is the opposite: a code is a key, and
-- naming the wrong one hands out somebody else's discount; an automatic offer
-- (« frais de port offerts dès 70 € », « masque offert dès 65 € », « 3+1 »)
-- is advertised on the site and applies itself, so describing it explains what
-- the customer already saw.
--
-- WHY NOW. Measured 2026-10-01 over the mailbox: about as many complaints are
-- about automatic offers as about codes — gifts charged at checkout, 3+1 not
-- applied, free shipping not applied — and the agent's promotion tools only
-- ever handled codes.
--
-- LOCAL, NOT FROM SHOPIFY. Survives the sync because `mapPromotionRow` never
-- writes it (shopify-promotion-mapper.test.mjs asserts that).
--
-- NO DATA IS WRITTEN beyond the column default.
--
-- COPIED FROM 02_shopify.sql, NOT RETYPED (57_describable_offers.test.mjs
-- asserts the column and its comment equal the baseline's).
--
-- IDEMPOTENT: `add column if not exists`.
--
-- Requires: 02_shopify.sql.
-- ============================================================================

alter table public.promotions
  add column if not exists describable_in_replies boolean not null default true;

comment on column public.promotions.describable_in_replies is
  'LOCAL, not from Shopify: may support describe this AUTOMATIC offer (free shipping, gift with purchase, multi-buy) to a customer? Survives the sync like offerable_in_replies -- mapPromotionRow never writes it. Defaults to true because an automatic offer is advertised on the site and applies itself, so explaining it hands out nothing; an operator turns one off to keep it out of replies. Ignored on code promotions, which offerable_in_replies governs.';

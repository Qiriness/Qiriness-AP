-- ============================================================================
-- 77 — THE NEWEST CHANGE IS ONE INDEX LOOKUP AWAY
--
-- `max(updated_at)` per shop on customers, orders and tickets was a full scan.
-- On customers (62k rows, ~76 MB of pages) that made `insights_freshness`, which
-- every Insights page awaits before its panel, take 12 s whenever the table had
-- fallen out of cache, against 250 ms warm (measured 2026-10-06). The worker's
-- change gate and its incremental passes (`updated_at >= since`) ask the same
-- question of orders and tickets every poll.
--
-- COPIED INTO 02_shopify.sql AND 04_support.sql (77_updated_at_indexes.test.mjs
-- asserts they agree). NO DATA IS WRITTEN. IDEMPOTENT.
-- ============================================================================

create index if not exists customers_shop_updated_at_idx on public.customers (shop_id, updated_at);

create index if not exists orders_shop_updated_at_idx on public.orders (shop_id, updated_at);

create index if not exists tickets_shop_updated_at_idx on public.tickets (shop_id, updated_at);

-- ============================================================================
-- 91 — DROP THREE INDEXES ANOTHER INDEX ALREADY PROVIDES
--
-- WHAT THIS REMOVES. Each is a plain btree whose columns are already the
--   leading columns of a unique index on the same table, so the planner can
--   always use the unique one instead; the plain copy only costs writes.
--     email_blocklist_shop_pattern_idx   = email_blocklist_shop_pattern_unique
--     sender_directory_shop_pattern_idx  = sender_directory_shop_pattern_unique
--     support_answers_shop_set_idx       = prefix of support_answers_shop_set_key_unique
--   (support_answers_shop_set_fallback_unique is PARTIAL — where is_fallback —
--   and is not a substitute; it stays.)
--
-- MEASURED 2026-10-12 on production (pg_stat since 2026-08-07). The copies are
--   used — sender_directory_shop_pattern_idx 31,395 scans, support_answers_
--   shop_set_idx 1,064, email_blocklist_shop_pattern_idx 16 — because the
--   planner picks either of two identical indexes; those scans move to the
--   unique ones. Each copy is 16 kB on a small table: this is hygiene (one
--   fewer index to write per insert/update), not a performance fix.
--
-- The baseline (04_support.sql, 05_exemplars.sql) no longer creates them, so a
-- fresh install and an existing database end in the same state.
--
-- IDEMPOTENT. Requires: 04_support.sql, 05_exemplars.sql.
-- ============================================================================

drop index if exists public.email_blocklist_shop_pattern_idx;
drop index if exists public.sender_directory_shop_pattern_idx;
drop index if exists public.support_answers_shop_set_idx;

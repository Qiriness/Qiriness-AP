-- ============================================================================
-- 32 — THE PRODUCTS THE SHOP PUT FORWARD, CARRIED AS THE TOOL WROTE THEM
--
-- WHAT THIS CHANGES. `ticket_investigations` gains `recommendations jsonb`,
-- holding `recommendProducts`' own answer: one entry per type of care asked
-- for, each with the product lines exactly as the tool rendered them.
--
-- WHY A COLUMN AND NOT A SUMMARY. Every other fact in a case file is the
-- investigation model's restatement of a tool result, and for most of them that
-- is right — a verdict needs judgement. A product list does not: the reply
-- quotes it almost verbatim. Measured on ticket 05c1b539 (2026-09-20), three
-- retellings of one list lost which product suited which skin, flattened three
-- groups into one sentence claiming all six suited reactive skin (two are in no
-- such selection), and invented a benefit for each name it could no longer
-- describe.
--
-- THE SAME TREATMENT `knowledge` ALREADY GETS, and for the same reason: an
-- approved article reaches the drafting stage as written rather than as a
-- paraphrase. This column is that decision applied to the other body of text a
-- reply quotes closely.
--
-- NO DATA IS WRITTEN and nothing existing is invalidated. Rows stored before
-- this default to `[]`, which renders as no block at all rather than as a
-- missing section, so old investigations re-read exactly as they did.
--
-- IDEMPOTENT: `add column if not exists`.
--
-- Requires: 04_support.sql.
-- ============================================================================

alter table public.ticket_investigations
  add column if not exists recommendations jsonb not null default '[]'::jsonb;

comment on column public.ticket_investigations.recommendations is
  'What recommendProducts put forward, as it rendered it: one entry per type of care, with the product lines a reply quotes. Written by code from the tool ledger, never by the model — see agent/src/investigation/investigate.mjs run.recommendations().';

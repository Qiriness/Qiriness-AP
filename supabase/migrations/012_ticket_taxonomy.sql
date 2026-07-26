-- Pins the ticket side of the support taxonomy (see 011 for the knowledge side and
-- scripts/lib/support-taxonomy.mjs for the vocabulary).
--
-- Two axes, stored separately rather than as one composed enum:
--   category / secondary_category  -> subject: what the email is about (14 values,
--                                     the same list knowledge articles use)
--   request_kind / secondary_...   -> what the sender wants (question | problem |
--                                     complaint | contact)
--
-- Why separate: "order_problem" as a single value would need stripping back to
-- "order" for every knowledge lookup, and it makes the categoriser choose 1-of-23
-- flat strings instead of 1-of-14 plus 1-of-4 (measurably easier for a cheap-tier
-- model, same expressiveness). The composed label is a display concern only --
-- describeTicketCategory() in the taxonomy module renders "Delivery — problem".
--
-- Why a *secondary* kind too: an email can raise two subjects of different kinds --
-- "my order arrived damaged (problem) and do you restock this shade? (question)".
-- One shared kind could not express that pair.
--
-- `complaint` is a kind, not a subject, so a delivery complaint is
-- (delivery, complaint). A standalone "complaints" bucket would have overlapped
-- every `problem` value and cost classifier accuracy.
--
-- level is DERIVED from (subject, kind) by defaultLevel() rather than guessed
-- independently -- two model-assigned fields on the same "needs action" axis could
-- otherwise contradict each other. The categoriser may only escalate above the
-- derived floor, never below it (clampLevel). cosmetovigilance is always level 4.

alter table public.tickets
  add column request_kind text,
  add column secondary_request_kind text;

-- Subjects: the shared 14. Deliberately excludes the knowledge-only faq and
-- brand_story -- nobody emails support "an FAQ".
alter table public.tickets
  drop constraint if exists tickets_category_check,
  add constraint tickets_category_check check (
    category is null or category in (
      'order', 'delivery', 'return_exchange', 'product', 'product_stock', 'payment',
      'account', 'promotions', 'cosmetovigilance', 'legal_privacy', 'b2b',
      'partner_collaboration', 'careers', 'other'
    )
  ),
  drop constraint if exists tickets_secondary_category_check,
  add constraint tickets_secondary_category_check check (
    secondary_category is null or secondary_category in (
      'order', 'delivery', 'return_exchange', 'product', 'product_stock', 'payment',
      'account', 'promotions', 'cosmetovigilance', 'legal_privacy', 'b2b',
      'partner_collaboration', 'careers', 'other'
    )
  ),
  add constraint tickets_request_kind_check check (
    request_kind is null or request_kind in ('question', 'problem', 'complaint', 'contact')
  ),
  add constraint tickets_secondary_request_kind_check check (
    secondary_request_kind is null
      or secondary_request_kind in ('question', 'problem', 'complaint', 'contact')
  ),
  -- A secondary kind without a secondary subject is meaningless; the subject is
  -- what the kind qualifies.
  add constraint tickets_secondary_pair_check check (
    secondary_request_kind is null or secondary_category is not null
  );

-- The queue filters and groups on (subject, kind) together.
create index tickets_shop_category_kind_idx
  on public.tickets (shop_id, category, request_kind);

comment on column public.tickets.category is
  'Primary subject, from the shared support taxonomy in scripts/lib/support-taxonomy.mjs -- the same 14 subjects knowledge articles use, so a ticket subject filters straight into the matching knowledge chunks. Constrained since 012 (previously free text pending the taxonomy).';

comment on column public.tickets.secondary_category is
  'Optional second subject when one email spans two topics. Same vocabulary as category.';

comment on column public.tickets.request_kind is
  'What the sender wants about the primary subject: question (answerable from knowledge), problem (needs an action), complaint (dissatisfaction, never auto-handled), contact (inbound B2B/partnership/careers, forwarded to a team). Kept separate from category so knowledge retrieval can filter on subject alone.';

comment on column public.tickets.secondary_request_kind is
  'Kind for secondary_category, since a second subject can be a different kind (an order problem plus a stock question). Null unless secondary_category is set.';

comment on column public.tickets.level is
  'Handling level 1-4, derived from (category, request_kind) by defaultLevel() in scripts/lib/support-taxonomy.mjs. The categoriser may escalate above that floor but never below it; cosmetovigilance is always 4.';

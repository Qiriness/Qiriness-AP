-- ============================================================================
-- 09 — SUPPORT PARAMETERS
-- The numbers the desk runs on, held once so nothing can disagree about them.
--
-- WHY THIS EXISTS, AND THE EVIDENCE FOR IT. A returns window is needed in three
-- places at once: a RULE has to compare it against a delivery date to decide
-- whether a return is still possible, an ARTICLE has to state it to a customer,
-- and a rule's answer skeleton has to tell the drafting agent what to say. Held
-- as prose in each, they drift — and on this shop they already had:
--
--     "Refund policy"          -> « une politique de retour de 30 jours »
--     "Livraisons et retours"  -> « un droit de rétractation … de 14 jours »
--
-- Both approved, both live, and which one a customer is told depends on which
-- article retrieval happens to surface. That is not a content bug to fix once;
-- it is what happens whenever one number lives in two paragraphs.
--
-- WHY IT IS NOT A KNOWLEDGE ARTICLE. An article is prose for retrieval, matched
-- by similarity and scoped to a subject. A parameter is read by CODE — the
-- return-eligibility deriver cannot parse « vous disposez de 30 jours » out of a
-- paragraph, and should not try. Same split as everywhere else here: prose for
-- people, closed values for machines.
--
-- WHY VALUES START NULL. The numbers are the merchant's, and this shop's two
-- articles disagree about the most important one. Seeding a guess would put a
-- third answer into circulation wearing the authority of a setting. A null
-- parameter is read as "not decided yet" and every caller must handle it, which
-- is the honest state until somebody chooses.
--
-- Requires: 01_foundation.sql (shops, set_updated_at).
-- ============================================================================

-- ------------------------------------------------------------ support_parameters

create table public.support_parameters (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,

  -- The stable handle code reads. Snake case, never displayed raw to a customer.
  parameter_key text not null,

  -- THE VALUE AS TEXT, PARSED BY KIND. One column rather than a number column
  -- and a text column, because a table with two value columns invites a row that
  -- fills the wrong one and reads as empty. `kind` says how to parse it, and the
  -- readers in `scripts/lib/parameters.mjs` are the only things that do.
  --
  -- NULL IS A REAL STATE and not a missing row: the parameter exists, its
  -- meaning is written down, and nobody has decided the number yet.
  value text,

  -- What the value means, which is what makes it parseable and renderable.
  --   days   -> a whole number of days ("30")
  --   amount -> a decimal in the shop's currency ("70.00")
  --   text   -> free text, for a return address or a carrier name
  kind text not null default 'days',

  -- For the person setting it. The label is the question they are answering.
  label text not null,
  description text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint support_parameters_kind_check check (kind in ('days', 'amount', 'text')),
  -- A key is a code identifier and is compared literally; a stray capital or
  -- space would produce a parameter nothing reads.
  constraint support_parameters_key_shape_check check (parameter_key ~ '^[a-z][a-z0-9_]*$'),
  -- A `days` parameter that is not a whole number cannot be compared against a
  -- date, and an `amount` that is not a number cannot be compared against a
  -- total. Refused here rather than left for a reader to discover.
  constraint support_parameters_value_shape_check check (
    value is null
    or (kind = 'days' and value ~ '^[0-9]+$')
    or (kind = 'amount' and value ~ '^[0-9]+(\.[0-9]{1,2})?$')
    or kind = 'text'
  )
);

create unique index support_parameters_shop_key_unique
  on public.support_parameters (shop_id, parameter_key);

create trigger support_parameters_set_updated_at
before update on public.support_parameters
for each row
execute function public.set_updated_at();

alter table public.support_parameters enable row level security;

comment on table public.support_parameters is
  'The numbers the support desk runs on -- returns window, dispatch delays, free-shipping threshold -- held once so a rule, an article and an answer skeleton cannot disagree about them. Read by code through scripts/lib/parameters.mjs; never retrieved as prose.';

comment on column public.support_parameters.value is
  'The value as text, parsed according to `kind`. NULL means the parameter exists and nobody has decided it yet -- a real state, and the one every parameter starts in, because seeding a guess would put a third answer into circulation wearing the authority of a setting.';

comment on column public.support_parameters.kind is
  'How to parse `value`: days (whole number), amount (decimal), text. Checked by constraint, so a days parameter can always be compared against a date.';

comment on column public.support_parameters.parameter_key is
  'The handle code reads, e.g. returns_window_days. Constrained to lower snake case: a key is compared literally, and a stray capital would produce a parameter nothing reads.';

-- ============================================================================
-- 55 — COMPANY POLICIES
--
-- `company_policies` (the library), `company_policy_versions` (every version's
-- text) and `company_policy_links` (a policy made available to a situation or a
-- rule), plus `ticket_investigations.company_policies` (what a case read).
--
-- NO DATA IS WRITTEN: the library starts empty. COPIED FROM 04_support.sql and
-- 05_exemplars.sql (55_company_policies.test.mjs asserts they agree).
-- IDEMPOTENT.
--
-- Requires: 04_support.sql, 05_exemplars.sql.
-- ============================================================================

alter table public.ticket_investigations
  add column if not exists company_policies jsonb not null default '[]'::jsonb;

comment on column public.ticket_investigations.company_policies is
  'The company policies this case read: [{ key, version, source }], source situation (linked to the matched situation), rule (linked to the selected rule) or agent (fetched by the model with getPolicy). Drafting reads each policy''s current text by key; the version says which text the investigation saw.';

create table if not exists public.company_policies (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,

  -- The handle the tool takes. Never changes once created.
  policy_key text not null,
  name text not null,
  -- When to use it: the model reads this to decide whether to fetch it.
  purpose text not null default '',
  -- Plain text. May carry {parameter} placeholders, filled at read time.
  content text not null default '',
  active boolean not null default true,
  -- Raised on every change of content.
  version integer not null default 1,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The dashboard user's id, never a name or an address.
  updated_by text,

  constraint company_policies_key_shape_check check (policy_key ~ '^[a-z][a-z0-9_]*$'),
  constraint company_policies_version_check check (version >= 1)
);

create unique index if not exists company_policies_shop_key_unique
  on public.company_policies (shop_id, policy_key);

drop trigger if exists company_policies_set_updated_at on public.company_policies;
create trigger company_policies_set_updated_at
before update on public.company_policies
for each row
execute function public.set_updated_at();

alter table public.company_policies enable row level security;

comment on table public.company_policies is
  'The company''s policies, each written once: linked to situations and rules through company_policy_links, and fetchable by the agent through the getPolicy tool. Deterministic company truth, never a verdict. Written only by scripts/lib/company-policies.mjs.';
comment on column public.company_policies.content is
  'The policy text. May carry {parameter} placeholders (support_parameters keys), filled when the agent reads it, so a number lives in one place.';
comment on column public.company_policies.version is
  'Raised on every change of content; each version''s text is kept in company_policy_versions, and a case file records the version it read.';

-- ---------------------------------------------------------------- company_policy_versions

create table if not exists public.company_policy_versions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  policy_id uuid not null references public.company_policies(id) on delete cascade,
  version integer not null,
  content text not null,
  saved_by text,
  saved_at timestamptz not null default now()
);

create unique index if not exists company_policy_versions_policy_version_unique
  on public.company_policy_versions (policy_id, version);

alter table public.company_policy_versions enable row level security;

comment on table public.company_policy_versions is
  'Every version of every policy''s text, append-only, so what the agent read for a case stays answerable after the policy is edited.';

-- ---------------------------------------------------------------- company_policy_links

create table if not exists public.company_policy_links (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  policy_id uuid not null references public.company_policies(id) on delete cascade,

  -- Exactly one: a whole situation (support_exemplars.exemplar_key), or one rule.
  situation_key text,
  answer_id uuid references public.support_answers(id) on delete cascade,

  created_by text,
  created_at timestamptz not null default now(),

  constraint company_policy_links_one_target_check check (
    (situation_key is null) <> (answer_id is null)
  )
);

create unique index if not exists company_policy_links_situation_unique
  on public.company_policy_links (policy_id, situation_key) where situation_key is not null;

create unique index if not exists company_policy_links_answer_unique
  on public.company_policy_links (policy_id, answer_id) where answer_id is not null;

create index if not exists company_policy_links_shop_idx
  on public.company_policy_links (shop_id);

alter table public.company_policy_links enable row level security;

comment on table public.company_policy_links is
  'Which policies a situation or a rule makes available to the agent: a reference, never a copy, so editing the policy changes every place it is linked. A situation''s links reach all its rules; a rule''s are added to them.';


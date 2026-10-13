-- ============================================================================
-- 49 — FORWARDING DESTINATIONS
--
-- Replaces one-address-per-category with named destinations. A category could
-- not say what the business needed: b2b mail goes to accounting when it is an
-- invoice, to the export desk when it is a foreign opportunity, to the France
-- desk when it is an institute, and stays in the dashboard when it is a
-- retailer's reorder PO. A destination names who receives it, which categories
-- it may take, and — in the business's own words — what it handles, which is
-- what the router reads when a category has more than one.
--
-- `forwarding_settings` holds the shop-wide acknowledgement: the fixed, never
-- model-written reply telling the sender their mail was passed on. Off until a
-- person turns it on.
--
-- `category_forwarding` is left in place: the forwarding pass still reads it
-- until the router lands, and it is dropped in that change.
--
-- NO DATA IS WRITTEN. COPIED FROM 04_support.sql (49_forwarding_destinations
-- .test.mjs asserts the two agree). IDEMPOTENT.
--
-- Requires: 04_support.sql.
-- ============================================================================

create table if not exists public.forwarding_destinations (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,

  -- What the dashboard calls it: « Comptabilité », « Export ».
  label text not null,
  -- Null is the off switch, as in category_forwarding: a destination can be
  -- described before its address is known, and switched off without losing it.
  forward_email text check (forward_email is null or forward_email like '%_@_%'),
  -- What it handles, in the business's words. The router's only guide when a
  -- category has several destinations, so it is written for a reader, not a rule.
  description text not null default '',

  categories text[] not null,
  -- Empty means any kind.
  request_kinds text[] not null default '{}',
  -- The agent checks the mail against the description even when this is the
  -- category's only destination, and keeps the ticket when it does not fit.
  -- Without it, one destination takes the whole category unread: right for
  -- careers, wrong for defects, where `product` problems also hold a customer
  -- who cannot reach the phone line.
  match_description boolean not null default false,

  timing text not null default 'immediate',
  acknowledge boolean not null default true,

  -- Customer-facing name in the acknowledgement. The French one carries its
  -- own preposition (« au service comptabilité »), since « à le » is wrong.
  public_name_fr text,
  public_name_en text,
  -- An extra paragraph in that destination's acknowledgement only.
  ack_note_fr text,
  ack_note_en text,

  position integer not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint forwarding_destinations_label_unique unique (shop_id, label),
  constraint forwarding_destinations_categories_check check (
    cardinality(categories) > 0
    and categories <@ array[
      'order', 'delivery', 'return_exchange', 'product', 'product_stock', 'payment',
      'account', 'promotions', 'cosmetovigilance', 'legal_privacy', 'b2b',
      'partner_collaboration', 'careers', 'other'
    ]::text[]
  ),
  constraint forwarding_destinations_request_kinds_check check (
    request_kinds <@ array['question', 'problem', 'complaint', 'contact']::text[]
  ),
  constraint forwarding_destinations_timing_check check (
    timing in ('immediate', 'after_first_reply')
  ),
  -- A destination that waits for our first reply has already written to the
  -- sender; a templated acknowledgement on top would repeat it.
  constraint forwarding_destinations_acknowledge_check check (
    not acknowledge or timing = 'immediate'
  )
);

create index if not exists forwarding_destinations_shop_idx
  on public.forwarding_destinations (shop_id, position);

drop trigger if exists forwarding_destinations_set_updated_at on public.forwarding_destinations;
create trigger forwarding_destinations_set_updated_at
before update on public.forwarding_destinations
for each row
execute function public.set_updated_at();

alter table public.forwarding_destinations enable row level security;

comment on table public.forwarding_destinations is
  'Who receives mail the contact team does not own: a name, an address (null = off), the categories and request kinds it may take, and a description in the business''s words that the router reads when a category has several destinations. Written by Agent Setup > Forwarding.';

comment on column public.forwarding_destinations.timing is
  'immediate: forwarded as soon as routed, with the acknowledgement. after_first_reply: forwarded once the contact team''s first reply has gone out (cosmetovigilance and defects ask for information first).';

comment on column public.forwarding_destinations.public_name_fr is
  'The phrase that follows « Nous l''avons transmis » in the acknowledgement, preposition included: « au service comptabilité ». Null reads « au service concerné ».';

create table if not exists public.forwarding_settings (
  shop_id uuid primary key references public.shops(id) on delete cascade,
  -- Off by default: this is the one email the system sends with no person
  -- approving it, so it is switched on deliberately.
  ack_enabled boolean not null default false,
  -- Null means the default template in scripts/lib/forwarding-destinations.mjs.
  ack_template_fr text,
  ack_template_en text,
  updated_at timestamptz not null default now()
);

drop trigger if exists forwarding_settings_set_updated_at on public.forwarding_settings;
create trigger forwarding_settings_set_updated_at
before update on public.forwarding_settings
for each row
execute function public.set_updated_at();

alter table public.forwarding_settings enable row level security;

comment on table public.forwarding_settings is
  'Shop-wide acknowledgement for forwarded mail: whether it is sent, and the FR/EN templates ({service}, {note}, {shop}). Null templates use the defaults in code.';

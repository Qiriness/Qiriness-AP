-- ============================================================================
-- 04 — FORWARDING
-- Where mail that is not customer work gets sent, and a record of every forward
-- actually made. Runs after 03: it depends on tickets.category and
-- tickets.request_kind, which 03 constrains.
--
-- WHAT THIS IS FOR. Some support mail is not support at all. A spontaneous job
-- application, a Nocibé reorder PO, a partner's regulatory feedback — nobody
-- owes the sender a customer-service answer; the right outcome is that the
-- person who handles that subject sees it. Measured on the corpus, 38 of 330
-- customer-facing tickets are exactly this shape: careers 11,
-- partner_collaboration 14, b2b 13. That is 12% of the inbox resolved by
-- delivering the mail somewhere, with no order lookup and no drafted reply.
--
-- WHY request_kind, NOT category. The taxonomy already carries this distinction:
-- `contact` means a first approach that asks nothing operational of us, and 03
-- documents it as only ever valid for b2b, partner_collaboration and careers.
-- Routing on the category alone would be wrong — `b2b` also holds genuine B2B
-- problems that need real work, and `payment` holds both supplier invoices and
-- customers whose card was declined. The pair (category has an address,
-- request_kind = 'contact') is the narrow, defensible rule.
--
-- WHY PER CATEGORY, NOT PER TEAM. tickets.responsible_team maps careers to
-- `contact` — the generic bucket — so a team-keyed address would send CVs to the
-- shared inbox they just came from. Categories are what people actually own:
-- careers to HR, b2b to sales, partner_collaboration to marketing.
-- ============================================================================

-- ============================================================================
-- category_forwarding — the address book
-- ============================================================================
--
-- One optional address per (shop, category). A category with no row, or a row
-- whose address is cleared, is never forwarded: absence is the off switch, so a
-- fresh install forwards nothing until somebody fills the form in. There is no
-- `enabled` flag because it would be a second way to express the same thing and
-- the two could disagree.
--
-- The address is a colleague's work address, not customer personal data — it is
-- stored in the clear because the whole point is to send mail to it, and it is
-- the one field an operator has to be able to read back and correct.

create table public.category_forwarding (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,

  -- The 14 ticket subjects from scripts/lib/support-taxonomy.mjs. The
  -- knowledge-only shapes (faq, brand_story) are deliberately absent: they are
  -- never ticket subjects, so nothing could ever route to them.
  category text not null check (
    category in (
      'order', 'delivery', 'return_exchange', 'product', 'product_stock', 'payment',
      'account', 'promotions', 'cosmetovigilance', 'legal_privacy', 'b2b',
      'partner_collaboration', 'careers', 'other'
    )
  ),

  -- Null or empty means "do not forward this category". Trimmed and
  -- lowercased by the writer; the check only rejects something that cannot be
  -- an address at all, since real-world validity is decided by Graph accepting
  -- the send, not by a regex.
  forward_email text check (forward_email is null or forward_email like '%_@_%'),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (shop_id, category)
);

create index category_forwarding_shop_idx on public.category_forwarding (shop_id);

create trigger category_forwarding_set_updated_at
before update on public.category_forwarding
for each row
execute function public.set_updated_at();

alter table public.category_forwarding enable row level security;

comment on table public.category_forwarding is
  'Per-category forwarding address book: which colleague receives mail of a given subject that asks nothing of customer support. Read by the agent forwarding step, written by the Agent Setup UI. A category with no row or a null address is never forwarded.';

comment on column public.category_forwarding.category is
  'Ticket subject from the shared taxonomy in scripts/lib/support-taxonomy.mjs. Only the 14 ticket subjects -- faq and brand_story are knowledge-only and cannot be a ticket category.';

comment on column public.category_forwarding.forward_email is
  'Internal recipient. Null or absent means this category is never forwarded, which is the default for every category on a fresh install.';

-- ============================================================================
-- ticket_forwards — what was actually sent
-- ============================================================================
--
-- IDEMPOTENCY, keyed on the MESSAGE not the ticket. `unique (ticket_message_id)`
-- is what stops a re-run, a retry or a replayed poll forwarding the same email
-- twice — the insert simply conflicts. Keying on the ticket instead would have
-- meant a candidate's follow-up, or a partner's reply three days later, never
-- reaching the person handling it: the first forward would have "covered" the
-- thread forever. Per message, each new inbound email is delivered once.
--
-- Failures are rows too (`status = 'failed'`), not silence. A send that Graph
-- rejected must be visible and retryable, and a table that only records
-- successes cannot tell "never attempted" from "attempted and lost".

create table public.ticket_forwards (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  ticket_id uuid not null references public.tickets(id) on delete cascade,

  -- The specific email forwarded. Unique, and the reason this table is safe to
  -- re-run against.
  ticket_message_id uuid not null unique references public.ticket_messages(id) on delete cascade,

  -- Snapshot of the routing decision at send time. Kept even though it is
  -- derivable, because the address book is editable: changing where careers mail
  -- goes tomorrow must not rewrite where it went yesterday.
  category text not null,
  forward_email text not null,

  status text not null default 'sent' check (status in ('sent', 'failed')),
  -- One line, no stack, no message body. Enough to see why and retry.
  error text,

  created_at timestamptz not null default now()
);

create index ticket_forwards_shop_idx on public.ticket_forwards (shop_id);
create index ticket_forwards_ticket_idx on public.ticket_forwards (ticket_id);
create index ticket_forwards_failed_idx on public.ticket_forwards (shop_id, status);

alter table public.ticket_forwards enable row level security;

comment on table public.ticket_forwards is
  'One row per email forwarded to a colleague, successful or not. Doubles as the idempotency ledger: unique(ticket_message_id) is what makes the forwarding step safe to re-run. Holds no message body -- the forwarded mail itself lives in the recipient mailbox and in ticket_messages.';

comment on column public.ticket_forwards.ticket_message_id is
  'THE IDEMPOTENCY KEY. Per message rather than per ticket, so a follow-up on an already-forwarded thread still reaches the recipient exactly once.';

comment on column public.ticket_forwards.category is
  'The category as it was when the forward was sent. Snapshot: editing the address book later must not rewrite history.';

comment on column public.ticket_forwards.status is
  'sent | failed. Failures are recorded rather than dropped, so a Graph rejection is visible and retryable instead of silently never happening.';

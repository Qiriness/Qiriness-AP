-- ============================================================================
-- 05 — SUPPORT EXEMPLARS
-- The recurring customer situations, their real phrasings, and the vector search
-- that matches an incoming ticket to one.
--
-- WHY THIS IS NOT `knowledge_documents`. An article answers a question; an
-- exemplar IS a question, plus a statement of what answering it will require.
-- Two consequences make it a separate table rather than a category value:
-- `requirement_needs` has to be constrained against the investigation's own
-- vocabulary (a knowledge document has nowhere to put that), and separation by
-- TABLE means retrieval can never accidentally reach an exemplar the way it
-- would if these lived under a category `categoriesToSearch()` might one day
-- return. A customer asking « où est ma commande » must never retrieve a
-- question as though it were policy.
--
-- SAME MECHANICS AS KNOWLEDGE, DELIBERATELY. Exemplar is to phrasing what
-- document is to chunk: the parent carries the meaning, the child carries the
-- vector and the determinism quadruple. That symmetry is the point — the
-- embedding reconciler, the staleness gate and the approve-gates-the-vector rule
-- are reused rather than reimplemented.
--
-- Requires: 01_foundation.sql (shops, set_updated_at, the `vector` extension) and
-- 03_knowledge.sql (knowledge_documents, which a rule may pin an article from).
-- and 03_knowledge.sql (the `public.french_unaccent` text search configuration).
-- ============================================================================

-- ---------------------------------------------------------------- support_exemplars

create table public.support_exemplars (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  -- The stable human handle from Email-Example-Queries.md (`P-16`, `D-01`).
  -- Carried so a row can be traced back to the analysis that produced it, and so
  -- a re-import updates rather than duplicates.
  exemplar_key text not null,
  canonical_question text not null,
  category text,
  request_kind text,
  -- WHAT ANSWERING THIS REQUIRES, from the investigation's closed vocabulary.
  -- `agent/src/investigation/evidence-rules.mjs` owns that list; a check
  -- constraint cannot import a module, so the migration test is what stops the
  -- two drifting apart — exactly as knowledge_documents.category is handled.
  requirement_needs text[] not null default '{}'::text[],
  -- Which family of answers this situation draws from. The indirection is the
  -- whole reason answers are shared: « pas encore expédiée » answers both D-01
  -- and O-09, and nesting answers inside exemplars would mean writing it twice
  -- and maintaining two copies of it for ever.
  answer_set text,
  -- WHETHER THE RULES MAY DIRECT COLLECTION FOR THIS SITUATION.
  --
  -- `model` is today's behaviour: the deterministic opening moves run and the
  -- model chooses everything after them. `rule_directed` additionally lets the
  -- planner propose the next fact to establish, from the same answer table that
  -- decides the reply. It may ADD and REORDER calls; it may never suppress one.
  --
  -- SET BY A PERSON, PER SITUATION, AND NEVER INFERRED FROM HOW MANY RULES
  -- EXIST. A set with 8 rules of which 3 are approved is worse than no rules at
  -- all: the live set converges faster because there is less to separate, so
  -- collection stops earlier while looking like it decided something. Per-set
  -- readiness is too coarse to see that, and per-rule is too fine to mean
  -- anything.
  --
  -- DEFAULTING TO `model` IS WHAT MAKES THE PLANNER INERT ON DELIVERY. Shipping
  -- it changes no ticket until a person opts a situation in.
  collection_mode text not null default 'model',
  -- WHETHER THE RULES MAY STOP COLLECTION EARLY for this situation.
  --
  -- A SECOND COLUMN RATHER THAN A THIRD VALUE ON THE ONE ABOVE, because they
  -- are different risks. Directing collection can only ADD a call, and its worst
  -- case is a wasted lookup. Stopping it can REMOVE one, and its worst case is a
  -- reply resting on a fact nobody fetched. A shop that wants the first must not
  -- get the second by implication.
  --
  -- BOTH STOPPING CONDITIONS MUST HOLD: the rule decided AND the response
  -- complete. Measured before this shipped -- on 58 of 90 runs the rule was
  -- already decided and 50 of those still produced established facts, 115 claims
  -- in all. The rule being settled says nothing about the reply being ready.
  --
  -- OFF, AND THE REPLAY SAYS KEEP IT OFF FOR NOW. Over 47 traced runs it would
  -- have saved 13 calls and lost 7 established facts, and every situation that
  -- saved anything also lost something. Re-run `report:collection-replay` before
  -- setting this anywhere.
  collection_suppresses boolean not null default false,
  locale text not null default 'fr',
  approval_status text not null default 'draft',
  -- Measured demand from `npm run cluster:tickets`: how many real messages sat
  -- behind this situation. Kept because it is the authoring priority and the
  -- denominator for any coverage number later.
  demand_message_count integer,
  source_note text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint support_exemplars_collection_mode_check check (
    collection_mode in ('model', 'rule_directed')
  ),
  constraint support_exemplars_approval_status_check check (
    approval_status in ('draft', 'in_review', 'approved', 'needs_optimization')
  ),
  constraint support_exemplars_demand_message_count_check check (
    demand_message_count is null or demand_message_count >= 0
  ),
  -- THE SHARED SUBJECT VOCABULARY, the same 14 the categoriser assigns. Unlike
  -- knowledge_documents this does NOT carry `faq` or `brand_story`: those are
  -- shapes an article takes, not situations a customer writes in about.
  constraint support_exemplars_category_check check (
    category is null or category in (
      'order', 'delivery', 'return_exchange', 'product', 'product_stock', 'payment',
      'account', 'promotions', 'cosmetovigilance', 'legal_privacy', 'b2b',
      'partner_collaboration', 'careers', 'other'
    )
  ),
  constraint support_exemplars_request_kind_check check (
    request_kind is null or request_kind in ('question', 'problem', 'complaint', 'contact')
  ),
  -- Every declared need must be one the investigation can actually score. An
  -- unrecognised key would read as a requirement nothing can ever satisfy.
  constraint support_exemplars_requirement_needs_check check (
    requirement_needs <@ array[
      'product_identity', 'product_property', 'product_availability', 'product_recommendation',
      'product_offer',
      'order_identity', 'order_state', 'delivery_state', 'dispatch_state', 'payment_state',
      'refund_state', 'return_eligibility', 'buyer_type',
      'promotion_identity', 'promotion_validity', 'promotion_eligibility',
      'customer_identity', 'customer_account_state', 'customer_history',
      'purchase_verified', 'photo_evidence', 'reaction_product',
      'policy_answer', 'brand_answer', 'checkout_state', 'other_fact'
    ]::text[]
  )
);

create unique index support_exemplars_shop_key_unique
  on public.support_exemplars (shop_id, exemplar_key);

create index support_exemplars_shop_category_idx
  on public.support_exemplars (shop_id, category);

create index support_exemplars_shop_deleted_at_idx
  on public.support_exemplars (shop_id, deleted_at);

create index support_exemplars_requirement_needs_gin_idx
  on public.support_exemplars using gin (requirement_needs);

create trigger support_exemplars_set_updated_at
before update on public.support_exemplars
for each row
execute function public.set_updated_at();

alter table public.support_exemplars enable row level security;

comment on table public.support_exemplars is
  'Recurring customer situations: a canonical question plus what answering it requires. Authored in the dashboard or imported from the clustered corpus; never auto-synced from Shopify.';

comment on column public.support_exemplars.exemplar_key is
  'Stable human handle from the source analysis (P-16, D-01). Unique per shop, so a re-import updates the existing row rather than creating a second one.';

comment on column public.support_exemplars.requirement_needs is
  'The facts a correct reply must rest on, from the closed vocabulary in agent/src/investigation/evidence-rules.mjs. Declared here as a second source alongside the per-ticket needs the decomposition model emits; which one wins is deliberately not settled in the schema.';

comment on column public.support_exemplars.approval_status is
  'Team review state. Only approved exemplars hold phrasing vectors, so this is also the retrieval gate -- the same rule as knowledge_documents.';

comment on column public.support_exemplars.demand_message_count is
  'How many real customer messages clustered behind this situation. Authoring priority, and the denominator for coverage reporting.';

comment on column public.support_exemplars.category is
  'Situation subject, from the shared support taxonomy. Used to filter retrieval; an exemplar must never re-route a ticket''s own category.';

-- ---------------------------------------------------------------- support_exemplar_phrasings

-- One row per way a customer actually says this. The canonical question is a
-- phrasing too, so retrieval has exactly one kind of thing to search.
--
-- WHY THE VARIANTS CARRY THE WEIGHT. The query side is a whole customer email:
-- long, misspelt, half-polite. A canonical question is short and tidy, and
-- comparing the two is comparing different registers. The variants are real
-- phrasings, so they match messy-to-messy — which is the entire reason to store
-- more than one row per exemplar.
create table public.support_exemplar_phrasings (
  id uuid primary key default gen_random_uuid(),
  support_exemplar_id uuid not null
    references public.support_exemplars(id) on delete cascade,
  phrasing_index integer not null,
  phrasing_kind text not null default 'variant',
  phrasing_text text not null,
  -- The language THIS PHRASING IS WRITTEN IN -- not the language to answer in,
  -- which is `tickets.language`. The vocabulary is shared with it anyway, because
  -- two lists of languages in one system is one list too many.
  --
  -- WHY IT EXISTS BEFORE ANYTHING WRITES ANYTHING BUT 'fr'. The corpus is French
  -- and so is the library, and an English email pays for that: measured
  -- 2026-08-12, French tickets match at median 0.637 and English at 0.476 -- a
  -- gap wider than the whole distance between the NEAR and MATCHED bands. The
  -- fix is non-French phrasings, real ones where the corpus has them and
  -- translations elsewhere, and none of that is reportable or regenerable
  -- without knowing what language each row is in.
  language text not null default 'fr',
  -- Which phrasing this was translated FROM, by index within the same exemplar.
  -- Null unless `phrasing_kind` is 'translated'. Carried so a translation can be
  -- regenerated when its source text is edited, and so a reviewer can see the
  -- original beside the machine output.
  translated_from_index integer,
  content_hash text not null,
  embedding vector(1536),
  -- The lexical half of hybrid retrieval, defined now and unused for the moment:
  -- exemplar matching ships dense-plus-metadata first. Generated, so it can
  -- never drift from the text it indexes, and using the same accent-insensitive
  -- French configuration 03 creates -- a query must be parsed the same way it
  -- was indexed or the accents problem comes back.
  search_vector tsvector generated always as (
    to_tsvector('public.french_unaccent', coalesce(phrasing_text, ''))
  ) stored,
  embedding_model text,
  embedding_dimensions integer,
  embedded_input_hash text,
  embedded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint support_exemplar_phrasings_index_unique
    unique (support_exemplar_id, phrasing_index),
  constraint support_exemplar_phrasings_index_check check (phrasing_index >= 0),
  constraint support_exemplar_phrasings_kind_check check (
    phrasing_kind in ('canonical', 'variant', 'translated')
  ),
  -- The same list as `tickets.language`, mirrored from
  -- `scripts/lib/support-taxonomy.mjs` and held in step by the migration test.
  constraint support_exemplar_phrasings_language_check check (
    language in ('fr', 'en', 'es', 'de', 'it', 'nl', 'pt', 'other')
  ),
  -- TWO INDEX SPACES IN ONE COLUMN, and the split is load-bearing rather than
  -- tidy. `import-exemplars.mjs` prunes by position: anything at or past the end
  -- of the authored list is text nobody wrote any more, and gets deleted. A
  -- translation appended after the authored phrasings would land squarely in
  -- that range and be destroyed on the next import — so translations live at
  -- 100 and above, out of reach of the pruner, and the database enforces it
  -- rather than trusting the two scripts to agree.
  --
  -- A translation must also name its source, and cannot be its own source.
  constraint support_exemplar_phrasings_translation_shape_check check (
    (phrasing_kind = 'translated'
       and translated_from_index is not null
       and translated_from_index <> phrasing_index
       and phrasing_index >= 100)
    or
    (phrasing_kind <> 'translated'
       and translated_from_index is null
       and phrasing_index < 100)
  ),
  constraint support_exemplar_phrasings_embedding_dimensions_check check (
    embedding_dimensions is null or embedding_dimensions = 1536
  )
);

create index support_exemplar_phrasings_exemplar_id_idx
  on public.support_exemplar_phrasings (support_exemplar_id);

create index support_exemplar_phrasings_embedding_hnsw_idx
  on public.support_exemplar_phrasings
  using hnsw (embedding vector_cosine_ops);

create index support_exemplar_phrasings_search_vector_gin_idx
  on public.support_exemplar_phrasings
  using gin (search_vector);

create trigger support_exemplar_phrasings_set_updated_at
before update on public.support_exemplar_phrasings
for each row
execute function public.set_updated_at();

alter table public.support_exemplar_phrasings enable row level security;

comment on table public.support_exemplar_phrasings is
  'Retrieval rows for support_exemplars: the canonical question plus every real phrasing of it. One vector each; the exemplar is scored by its best-matching phrasing.';

comment on column public.support_exemplar_phrasings.phrasing_kind is
  'canonical for the tidy question, variant for a real customer phrasing, translated for machine output derived from one of the other two. All three are embedded and searched identically; the distinction is for the editor and for reporting which register actually matches.';

comment on column public.support_exemplar_phrasings.language is
  'The language this phrasing is written in, from the same vocabulary as tickets.language. Defaults to fr because the authored corpus is French. Retrieval does NOT filter on it -- an English email is free to match a French phrasing, just poorly, which is the problem this column exists to let us measure.';

comment on column public.support_exemplar_phrasings.translated_from_index is
  'The phrasing_index this was translated from, within the same exemplar. Null unless phrasing_kind is translated. Translations occupy phrasing_index 100 and above so that import-exemplars.mjs, which prunes anything past the end of the authored list, cannot delete them.';

comment on column public.support_exemplar_phrasings.embedding is
  'pgvector embedding (text-embedding-3-small, 1536 dims). Present only while the parent exemplar is approved and the vector matches the current composed input; cleared when it leaves approved.';

comment on column public.support_exemplar_phrasings.embedded_input_hash is
  'Hash of the exact text sent to the embedding model. Unlike a knowledge chunk, a phrasing is embedded ALONE -- no title or heading prefix -- because it is already a complete question and the query it is compared against is a bare customer email.';

comment on column public.support_exemplar_phrasings.search_vector is
  'Lexical index over the phrasing, accent-insensitive French. Defined ahead of use: exemplar retrieval ships dense-plus-metadata, and turning on the lexical half should be a code change rather than a schema one.';

-- ---------------------------------------------------------------- support_answers

-- The answer skeletons, keyed by EVIDENCE POSITION rather than by question.
--
-- WHY SHARED AND NOT NESTED. Nesting an answer set inside each exemplar is the
-- obvious shape and it multiplies: 32 situations times three to five branches is
-- 100-160 drafts, and most are duplicates — « votre commande n'est pas encore
-- expédiée » answers both "where is my order" and "why has it not shipped".
--
-- The findings vocabulary is what makes sharing possible. A `when` clause is a
-- conjunction over CLOSED enums, so the space of distinct evidence positions is
-- bounded by the vocabulary rather than by the question count. The promotions
-- family collapses to four positions serving five questions; across all four
-- families the estimate is 10-15 answers rather than 160.
--
-- A SKELETON, NOT A REPLY. This is guidance for the drafting agent, never text
-- sent to a customer, which is exactly what makes sharing safe: the per-question
-- wording is the drafting agent's job. It must not restate policy either — it
-- names `policy_answer` and lets knowledge retrieval supply the sentence, or a
-- returns-window change means editing an article AND every answer quoting it.
create table public.support_answers (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  -- The family (`promo`, `commande`, `retour`, `produit`) plus the state within
  -- it. Exemplars reference the family; conditions pick the state.
  answer_set text not null,
  answer_key text not null,
  -- WHICH SITUATION THIS RULE IS FOR, or null for "any situation in this set".
  --
  -- THE SECOND AXIS, and it exists because the two questions are different
  -- kinds. `when_conditions` says what is TRUE about the order; this says what
  -- the customer WANTS. « où est ma commande » and « il manque un article dans
  -- le colis » are two delivery tickets with identical order facts and different
  -- answers, so evidence alone cannot separate them. The reverse holds too: a
  -- cancellation is possible or not depending on a fulfilment status, which no
  -- amount of reading the customer's phrasing can settle.
  --
  -- So the embedding decides the intent, the evidence decides the state, and a
  -- rule may name either or both. Nullable on purpose: a rule naming only
  -- conditions still fires when no exemplar matched, which is why coverage does
  -- not depend on the matcher's recall.
  situation_key text,
  -- { need: [findings] } — a conjunction across needs, a disjunction within one.
  -- `promotion_validity: ['expired','not_found']` is one row because "the code
  -- cannot be used at all" is one answer however it got that way.
  when_conditions jsonb not null default '{}'::jsonb,
  answer_skeleton text,
  -- WHERE A MATCHED RULE SENDS THE TICKET, or null to leave the verdict exactly
  -- as the investigation set it.
  --
  -- TIGHTEN ONLY, AND THE SCHEMA IS WHAT GUARANTEES IT. `answerable` is absent
  -- from the check by design: a rule may hand a ticket to a person or turn it
  -- into a question, and may never declare something safe that the investigation
  -- did not. That is the same direction `buildCaseFile` already overrides in
  -- (downwards, never upwards) and the same ratchet the level follows — put in a
  -- constraint rather than in code because it is the one property of this table
  -- that must not be revisited by a future caller.
  route text,
  -- The `MISSING_FIELDS` keys, when the rule's answer is to ask for something.
  --
  -- THE KEY, NEVER THE SENTENCE. `case-file.mjs` owns the exact wording of every
  -- request; storing prose here would be a second version of it, and the two
  -- would drift the first time somebody improved one.
  --
  -- A LIST SINCE 2026-08-30, and it was singular for no reason anybody had
  -- checked. A reaction reported with no product named needs BOTH the product
  -- and the batch number, and with one slot the rule had to drop one of them —
  -- which turns one reply into two round trips with a customer who is waiting
  -- on an answer about their skin. `missing` on the case file was already a
  -- list; this was the only narrowing between a rule and it.
  --
  -- `'{}'` RATHER THAN NULL, so "asks for nothing" has one representation. The
  -- singular column was nullable and the route constraint below turned on
  -- `ask is null`; an empty array and a null would have been two ways to say the
  -- same thing, which is the shape that produces a constraint passing on the row
  -- it exists to refuse.
  ask text[] not null default '{}'::text[],
  -- A LIVE DISCOUNT CODE THIS RULE HANDS TO THE CUSTOMER, or null.
  --
  -- THE ONE PLACE A RULE CARRIES A VALUE RATHER THAN A CONDITION, and it is here
  -- because "which code do we give somebody who never received theirs" is a
  -- commercial decision that changes with the season and cannot be derived from
  -- the ticket. The operator picks it once, on the rule, from the codes marked
  -- `offerable_in_replies` -- so it is chosen deliberately rather than per reply
  -- under time pressure, and the same customer situation always gets the same
  -- offer.
  --
  -- NOT VALIDATED BY THIS CONSTRAINT, and it cannot be: the codes live in
  -- `promotions`, which the Shopify sync rewrites, so a foreign key would either
  -- block the sync or delete rules when a promotion expires. It is re-checked at
  -- DRAFTING time instead and dropped if it has stopped being offerable, the
  -- same treatment `fillParameters` gives a parameter nobody has set.
  offer_code text,
  -- THE APPROVED ARTICLE THAT ANSWERS THIS RULE'S POSITION, or null.
  --
  -- The second value a rule carries, and the same kind of decision `offer_code`
  -- is: some situations have a canonical answer sitting in one article, and
  -- rediscovering that by semantic search on every ticket makes the reply depend
  -- on retrieval's mood. « livrez-vous dans mon pays ? » is the case that
  -- prompted it -- three approved articles answer it with three different
  -- country lists, and which one retrieval reaches depends on the ticket's
  -- category.
  --
  -- PER RULE, NOT PER SITUATION, which looks like the wrong axis until D-33 is
  -- read: pinned to the situation, the article would also attach to the branch
  -- that fires when NO article answered, which exists for exactly that case. The
  -- branch is what knows whether an article applies. A rule already carries
  -- `situation_key`, so per-rule says "per situation" whenever it should.
  --
  -- A REAL FOREIGN KEY, unlike `offer_code` -- these rows are ours and are not
  -- rewritten by a Shopify sync, so the reference can be enforced. `set null`
  -- rather than cascade: deleting an article must never delete the rules that
  -- cited it. Approval is still re-checked at DRAFTING time, because a document
  -- can be unapproved without being deleted.
  knowledge_document_id uuid references public.knowledge_documents(id) on delete set null,
  -- THE TONES THIS RULE'S REPLY SHOULD TAKE, as keys of
  -- `scripts/lib/reply-tones.mjs`, which owns their wording.
  --
  -- PER RULE, NOT PER SITUATION, for the reason `knowledge_document_id` gives:
  -- D-01 is either late (`d01_expedition_en_retard`, where an apology belongs) or
  -- within the window (`d01_expedition_dans_le_delai`, whose skeleton forbids
  -- one), and only the branch knows which. Several may be picked; an email
  -- carrying two requests gets the union of both rules' tones.
  --
  -- `'{}'` means the Brand voice alone -- one representation, as `ask` has.
  tones text[] not null default '{}'::text[],
  -- Ordering among rows that match equally deeply. Most-specific wins first;
  -- this only breaks the tie, so authoring order never becomes load-bearing by
  -- accident.
  priority integer not null default 0,
  -- The catch-all for its set. At most one per set, and its conditions are
  -- ignored — without one, an unmatched evidence position resolves to no answer
  -- and the ticket goes to a person, which is the correct default but a poor
  -- experience to discover by accident.
  is_fallback boolean not null default false,
  approval_status text not null default 'draft',
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint support_answers_approval_status_check check (
    approval_status in ('draft', 'in_review', 'approved', 'needs_optimization')
  ),
  constraint support_answers_when_conditions_object_check check (
    jsonb_typeof(when_conditions) = 'object'
  ),
  -- A fallback with conditions is a contradiction: it would read as though the
  -- conditions gated it when they are ignored.
  constraint support_answers_fallback_has_no_conditions_check check (
    not is_fallback or when_conditions = '{}'::jsonb
  ),
  -- THE TIGHTEN-ONLY GUARANTEE. `answerable` is deliberately not in this list:
  -- a rule may send a ticket to a person or turn it into a question, and may
  -- never declare one safe. The two values here are exactly the verdicts in
  -- `case-file.mjs` minus that one, and `05_exemplars.test.mjs` asserts the
  -- relationship rather than trusting two lists to keep agreeing.
  constraint support_answers_route_check check (
    route is null or route in ('needs_human', 'needs_customer_input')
  ),
  -- Every askable fact `MISSING_FIELDS` owns the sentence for. A key outside it
  -- would be a rule asking a question nothing can word.
  constraint support_answers_ask_check check (
    ask <@ array[
      'shopify_order_number', 'purchase_email', 'product_name',
      'purchase_channel', 'photo', 'promotion_code', 'order_date_or_amount',
      'reaction_product_name', 'lot_number', 'account_email'
    ]::text[]
  ),
  -- Every tone `reply-tones.mjs` can word. A key outside it would be a choice
  -- that saves and changes nothing.
  constraint support_answers_tones_check check (
    tones <@ array[
      'reassuring', 'empathetic', 'factual', 'firm', 'apologetic', 'understanding'
    ]::text[]
  ),
  -- A rule that asks must say so in its route, or the drafting stage gets a
  -- question to ask and a verdict that does not permit asking it —
  -- `draftDecision` refuses that combination as `nothing_to_ask`.
  --
  -- `IS NOT DISTINCT FROM` RATHER THAN `=`, AND IT IS NOT STYLE. `route = '…'`
  -- is NULL when route is null, `false or NULL` is NULL, and a CHECK that
  -- evaluates to NULL PASSES. Written the obvious way this constraint accepted
  -- exactly the row it exists to refuse — an `ask` with no route — which is how
  -- it was caught: by inserting one against the live table rather than reading
  -- the clause. The three-valued form is total.
  -- An empty string is a code nobody can use and a null wearing a disguise.
  constraint support_answers_offer_code_not_blank_check check (
    offer_code is null or length(btrim(offer_code)) > 0
  ),
  constraint support_answers_ask_needs_route_check check (
    cardinality(ask) = 0 or route is not distinct from 'needs_customer_input'
  )
);

create unique index support_answers_shop_set_key_unique
  on public.support_answers (shop_id, answer_set, answer_key);

-- At most one catch-all per set. Two would make "which answer" depend on sort
-- order at the exact moment nothing else matched.
create unique index support_answers_shop_set_fallback_unique
  on public.support_answers (shop_id, answer_set)
  where is_fallback;

create index support_answers_shop_set_idx
  on public.support_answers (shop_id, answer_set);

create index support_answers_when_conditions_gin_idx
  on public.support_answers using gin (when_conditions);

create trigger support_answers_set_updated_at
before update on public.support_answers
for each row
execute function public.set_updated_at();

alter table public.support_answers enable row level security;

comment on table public.support_answers is
  'Answer skeletons keyed by evidence position, shared across exemplars. Guidance for the drafting agent, never text sent to a customer. Selection is by matching when_conditions against the findings resolved in evidence-rules.mjs -- most-specific wins, priority breaks ties.';

comment on column public.support_answers.when_conditions is
  'A conjunction across needs, a disjunction within one: { "promotion_validity": ["expired","not_found"] } matches when validity took either value. Keys are needs and values are findings, both from agent/src/investigation/evidence-rules.mjs; the condition builder validates against findingValues() so a typo cannot become a permanently dead branch.';

comment on column public.support_answers.answer_set is
  'The family this answer belongs to (promo, commande, retour, produit). support_exemplars.answer_set names which family a situation draws from; without that scoping a promotions answer could be selected for a product question whose need sets happen to overlap.';

comment on column public.support_answers.is_fallback is
  'The catch-all for this set, whose conditions are ignored. At most one per set. Absent one, an unmatched evidence position yields no answer and the ticket routes to a person.';

comment on column public.support_answers.situation_key is
  'Which situation this rule is for (support_exemplars.exemplar_key), or null for any situation in the set. The second axis: when_conditions says what is true about the order, this says what the customer wants. A rule naming only conditions still fires when no exemplar matched.';

comment on column public.support_answers.route is
  'Where a matched rule sends the ticket, or null to leave the verdict as the investigation set it. Tighten only -- "answerable" is absent from the check constraint by design, so a rule can hand a ticket to a person but never declare one safe.';

comment on column public.support_answers.offer_code is
  'A live discount code this rule hands to the customer, chosen by an operator from the promotions marked offerable_in_replies. The one place a rule carries a VALUE rather than a condition: which code to give somebody is a commercial decision that changes with the season and cannot be derived from the ticket. No foreign key -- promotions is Shopify-synced, so a constraint would block the sync or delete rules when a code expires. Re-checked at drafting time and dropped if it has stopped being offerable.';

comment on column public.support_answers.knowledge_document_id is
  'The approved article that answers this rule''s position, or null. The second value a rule carries rather than a condition, alongside offer_code, and for the same reason: some situations have a canonical answer in one article and rediscovering it by semantic search per ticket makes the reply depend on retrieval. PER RULE, NOT PER SITUATION -- pinned to the situation it would also attach to the branch that fires when NO article answered, which is the branch that exists for exactly that case. A real FK, unlike offer_code, because these rows are ours and no sync rewrites them; set null on delete so removing an article never removes a rule. Approval is re-checked at drafting time and the article dropped if it is no longer approved, the same treatment offer_code gets.';
comment on column public.support_answers.ask is
  'MISSING_FIELDS keys when the rule''s answer is to ask for something. Keys, never sentences: case-file.mjs owns the wording. A LIST because one reply can need two facts -- a reaction with no product named wants the product AND the batch number, and one slot would have made that two round trips. Empty rather than null for "asks nothing". A non-empty list requires route = needs_customer_input, or drafting would hold a question it is not permitted to ask.';

comment on column public.support_answers.tones is
  'The tones this rule''s reply should take, as keys of scripts/lib/reply-tones.mjs, which owns their wording. Empty means the Brand voice alone. PER RULE, NOT PER SITUATION: D-01 late wants an apology and D-01 within the window forbids one, and only the branch knows which. When an email carries two requests their rules'' tones are unioned. A tone adjusts the Brand voice in the drafting prompt and never overrides its structural rules.';

-- ============================================================================
-- EXEMPLAR RETRIEVAL
-- Given an embedded ticket, which situation is this?
--
-- RETURNS ONE ROW PER EXEMPLAR, not per phrasing. Five phrasings of the same
-- situation are five ways of saying one thing, and a caller ranking them
-- separately would see its top three slots filled by a single exemplar. The
-- exemplar is scored by its BEST phrasing -- not an average, which would punish
-- an exemplar for having one loosely-worded variant.
--
-- THE APPROVAL GATE IS `embedding is not null`, exactly as in 03: the pipeline
-- only vectorises phrasings of an approved exemplar, so a second status check
-- here would imply that invariant is not trusted. `deleted_at` IS checked, and
-- that is not inconsistent -- a soft delete is a state the embedding pipeline
-- does not currently observe, so the vector can outlive the intent.
-- ============================================================================

create or replace function public.match_support_exemplars(
  query_embedding vector(1536),
  match_shop_id uuid,
  match_categories text[] default null,
  match_count integer default 3,
  min_similarity double precision default 0
)
returns table (
  exemplar_id uuid,
  exemplar_key text,
  canonical_question text,
  category text,
  request_kind text,
  requirement_needs text[],
  matched_phrasing text,
  matched_phrasing_kind text,
  -- Reported, never filtered on. Which language won tells you whether the
  -- non-French phrasings are earning their place; filtering by it would stop an
  -- English email matching a French phrasing, which is worse than matching it
  -- weakly.
  matched_phrasing_language text,
  similarity double precision
)
language sql
stable
-- Explicit search_path: this runs under the service role, so it must not be
-- resolvable against a caller-controlled schema.
set search_path = public
as $$
  with ranked as (
    -- The index lookup. Over-fetched because the limit applies to PHRASINGS
    -- while the caller counts EXEMPLARS: without headroom, one situation whose
    -- five variants all rank highly would return a single result for a request
    -- of three.
    --
    -- THE INVARIANT: the multiplier must stay above the largest number of
    -- phrasings any one exemplar has.
    --
    -- IT IS 64 BECAUSE THE LIBRARY IS TRANSLATED. It was 8 against a largest
    -- authored count of 5, and translation is what the old comment here warned
    -- would break it: D-33 has 8 authored phrasings and 32 translations, so at
    -- 8 it alone would fill all 24 slots of a three-exemplar request and the
    -- function would return one result. Silently — it reads as a retrieval
    -- quality problem rather than as arithmetic, which is why the number is
    -- derived rather than observed.
    --
    -- 64 IS THE INDEX SCHEME'S CEILING, NOT TODAY'S LARGEST ROW. Translations
    -- are addressed `100 + source * 10 + language slot`, which
    -- `exemplar-translation.mjs` caps at 10 authored phrasings and 5 languages
    -- — at most 60 rows for one exemplar, whatever anybody adds to the
    -- document. Setting it from the measured 40 instead would mean one new
    -- variant on D-33 could quietly reintroduce the same failure.
    select
      p.support_exemplar_id,
      p.phrasing_text,
      p.phrasing_kind,
      p.language,
      1 - (p.embedding <=> query_embedding) as similarity
    from public.support_exemplar_phrasings p
    join public.support_exemplars e on e.id = p.support_exemplar_id
    where p.embedding is not null
      and e.shop_id = match_shop_id
      and e.deleted_at is null
      and (match_categories is null or e.category = any (match_categories))
    order by p.embedding <=> query_embedding
    limit greatest(match_count, 1) * 64
  ),
  best as (
    select distinct on (support_exemplar_id) *
    from ranked
    order by support_exemplar_id, similarity desc
  )
  select
    e.id,
    e.exemplar_key,
    e.canonical_question,
    e.category,
    e.request_kind,
    e.requirement_needs,
    b.phrasing_text,
    b.phrasing_kind,
    b.language,
    b.similarity
  from best b
  join public.support_exemplars e on e.id = b.support_exemplar_id
  where b.similarity >= min_similarity
  order by b.similarity desc
  limit greatest(match_count, 1);
$$;

comment on function public.match_support_exemplars is
  'Vector search over approved exemplar phrasings, returning one row per EXEMPLAR scored by its best-matching phrasing. Returns cosine SIMILARITY (higher is better), not the raw <=> distance. `match_categories` is a caller-supplied list because which subjects are worth searching is policy -- see agent/src/retrieval/exemplar-rules.mjs. Bands are NOT the knowledge bands: a short canonical question scores differently against a long email than a prose chunk does, and they are calibrated separately.';

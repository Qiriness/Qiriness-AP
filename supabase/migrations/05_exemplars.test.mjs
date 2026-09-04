import assert from 'node:assert/strict';
import test from 'node:test';

import { NEED_KEYS } from '../../agent/src/investigation/evidence-rules.mjs';
import { MISSING_FIELDS, VERDICTS } from '../../agent/src/investigation/case-file.mjs';
import {
  REPLY_LANGUAGES,
  REQUEST_KINDS,
  TICKET_SUBJECTS
} from '../../scripts/lib/support-taxonomy.mjs';
import { TRANSLATION_INDEX_BASE } from '../../scripts/lib/exemplar-import.mjs';

import { checkClause, codeOnly, literalsIn, read, tablesIn } from './_shared.test.mjs';

const SQL = read('05_exemplars');

test('it creates exactly the three exemplar tables', () => {
  assert.deepEqual(tablesIn(SQL).sort(), [
    'support_answers',
    'support_exemplar_phrasings',
    'support_exemplars'
  ]);
});

// --- answers, which are shared rather than nested ----------------------------

test('an answer is keyed by set and key, unique per shop', () => {
  // Shared across exemplars: « pas encore expédiée » answers two questions, and
  // nesting would mean two copies to keep in step.
  assert.match(
    SQL,
    /create unique index support_answers_shop_set_key_unique[\s\S]*?\(shop_id, answer_set, answer_key\)/
  );
});

test('at most one fallback per answer set', () => {
  // Two would make "which answer" depend on sort order at the exact moment
  // nothing else matched.
  assert.match(
    SQL,
    /create unique index support_answers_shop_set_fallback_unique[\s\S]*?where is_fallback/
  );
});

test('a fallback cannot carry conditions', () => {
  // Its conditions are ignored, so having them reads as though they gated it.
  const clause = checkClause(SQL, 'support_answers_fallback_has_no_conditions_check');
  assert.ok(clause, 'the constraint is missing');
  assert.match(clause, /not is_fallback or when_conditions = '\{\}'::jsonb/);
});

test('when_conditions must be an object, not an array or scalar', () => {
  const clause = checkClause(SQL, 'support_answers_when_conditions_object_check');
  assert.match(clause, /jsonb_typeof\(when_conditions\) = 'object'/);
});

test('an exemplar names which answer family it draws from', () => {
  // Without the scoping a promotions answer could be selected for a product
  // question whose need sets happen to overlap.
  assert.match(SQL, /^\s*answer_set text,/m);
});

// --- the vocabularies, which are copies and must not drift -------------------

test('requirement_needs accepts exactly the investigation vocabulary', () => {
  // The whole mechanism rests on this: an exemplar may only declare a need code
  // can actually score. A key here that evidence-rules.mjs does not know would
  // be a requirement nothing could ever satisfy, and a key it knows that is
  // missing here would be un-declarable. A check constraint cannot import a
  // module, so this test is the only thing holding the two lists together.
  const clause = checkClause(SQL, 'support_exemplars_requirement_needs_check');
  assert.ok(clause, 'the constraint is missing');
  assert.deepEqual(literalsIn(clause), [...NEED_KEYS].sort());
});

test('category accepts the ticket subjects and nothing knowledge-only', () => {
  const clause = checkClause(SQL, 'support_exemplars_category_check');
  assert.deepEqual(literalsIn(clause), [...TICKET_SUBJECTS].sort());
  // `faq` and `brand_story` are shapes an article takes, not situations a
  // customer writes in about. knowledge_documents carries them; this must not.
  assert.ok(!literalsIn(clause).includes('faq'));
  assert.ok(!literalsIn(clause).includes('brand_story'));
});

test('request_kind accepts exactly the taxonomy kinds', () => {
  const clause = checkClause(SQL, 'support_exemplars_request_kind_check');
  assert.deepEqual(literalsIn(clause), [...REQUEST_KINDS].sort());
});

test('approval_status matches the knowledge library states', () => {
  // Deliberately the same four, because the approve-gates-the-vector rule is
  // shared and a reviewer moving between the two libraries should not have to
  // learn a second set of words.
  const clause = checkClause(SQL, 'support_exemplars_approval_status_check');
  assert.deepEqual(literalsIn(clause), ['approved', 'draft', 'in_review', 'needs_optimization']);
});

// --- language, and the two index spaces it needs -----------------------------

test('a phrasing language comes from the same vocabulary as a ticket language', () => {
  // Two lists of languages in one system is one list too many. The meanings
  // differ -- what this row is written in, versus what to reply in -- but the
  // values must not.
  const clause = checkClause(SQL, 'support_exemplar_phrasings_language_check');
  assert.ok(clause, 'the constraint is missing');
  assert.deepEqual(literalsIn(clause), [...REPLY_LANGUAGES].sort());
});

test('a phrasing defaults to French, because the authored corpus is', () => {
  assert.match(SQL, /^\s*language text not null default 'fr',/m);
});

test('translated is a phrasing kind alongside the two authored ones', () => {
  const clause = checkClause(SQL, 'support_exemplar_phrasings_kind_check');
  assert.deepEqual(literalsIn(clause), ['canonical', 'translated', 'variant']);
});

test('translations sit above the index range the importer prunes', () => {
  // THE ONE THAT PROTECTS REAL WORK. `import-exemplars.mjs` deletes any phrasing
  // at or past the end of the authored list, which is every translation if they
  // share an index space. The constraint is what stops the two scripts drifting
  // into disagreeing about that boundary.
  const clause = checkClause(SQL, 'support_exemplar_phrasings_translation_shape_check');
  assert.ok(clause, 'the constraint is missing');
  assert.match(clause, /phrasing_kind = 'translated'[\s\S]*?phrasing_index >= 100/);
  assert.match(clause, /phrasing_kind <> 'translated'[\s\S]*?phrasing_index < 100/);
});

test('the boundary the constraint enforces is the one the importer uses', () => {
  // Asserted against the module rather than the number, so moving the base moves
  // both or fails here.
  assert.equal(TRANSLATION_INDEX_BASE, 100);
  const clause = checkClause(SQL, 'support_exemplar_phrasings_translation_shape_check');
  assert.match(clause, new RegExp(`phrasing_index >= ${TRANSLATION_INDEX_BASE}`));
});

test('a translation names its source, and an authored phrasing has none', () => {
  const clause = checkClause(SQL, 'support_exemplar_phrasings_translation_shape_check');
  assert.match(clause, /translated_from_index is not null/);
  assert.match(clause, /translated_from_index <> phrasing_index/);
  assert.match(clause, /translated_from_index is null/);
});

// --- retrieval ---------------------------------------------------------------

test('the search function reports which language matched', () => {
  // Reported, never filtered on: an English email matching a French phrasing
  // weakly is better than not matching it at all. This is how we find out
  // whether the non-French phrasings are earning their place.
  assert.match(SQL, /matched_phrasing_language text/);
  assert.match(SQL, /^\s*p\.language,/m);
});


test('the search function returns similarity, never raw distance', () => {
  // `<=>` is cosine DISTANCE: 0 is perfect and the numbers run the wrong way for
  // any threshold a person has to reason about. Every score in this codebase is
  // on one scale, higher-is-better.
  assert.match(SQL, /1 - \(p\.embedding <=> query_embedding\) as similarity/);
});

test('the search function returns one row per exemplar, not per phrasing', () => {
  // Five phrasings of one situation are five ways of saying the same thing.
  // Without this a caller asking for three matches gets one exemplar three times.
  assert.match(SQL, /distinct on \(support_exemplar_id\)/);
});

test('the phrasing pool is over-fetched relative to the exemplar count', () => {
  // The inner limit counts phrasings while the caller counts exemplars, so
  // without headroom one situation whose variants all rank highly starves the
  // result set.
  assert.match(SQL, /limit greatest\(match_count, 1\) \* \d+/);
});

test('retrieval cannot reach an unembedded or deleted exemplar', () => {
  assert.match(SQL, /where p\.embedding is not null/);
  assert.match(SQL, /e\.deleted_at is null/);
});

test('the search function pins its search_path', () => {
  // It runs under the service role, so it must not resolve against a
  // caller-controlled schema.
  assert.match(SQL, /set search_path = public/);
});

test('categories are a caller-supplied list, not baked into SQL', () => {
  // Which subjects are worth searching is policy that changes as the corpus
  // fills; it lives in agent/src/retrieval where it can be tested and argued
  // with. Null searches everything.
  assert.match(SQL, /match_categories text\[\] default null/);
  assert.match(SQL, /match_categories is null or e\.category = any \(match_categories\)/);
});

// --- structure ---------------------------------------------------------------

test('a phrasing belongs to exactly one exemplar and dies with it', () => {
  assert.match(
    codeOnly(SQL),
    /references public\.support_exemplars\(id\) on delete cascade/
  );
});

test('an exemplar key is unique per shop, so a re-import updates', () => {
  assert.match(SQL, /create unique index support_exemplars_shop_key_unique[\s\S]*?\(shop_id, exemplar_key\)/);
});

test('phrasings carry the full determinism quadruple', () => {
  // Without all four a re-run cannot tell "unchanged" from "embedded by an
  // older model", and the reconciler stops being a no-op.
  for (const column of [
    'embedding_model',
    'embedding_dimensions',
    'embedded_input_hash',
    'embedded_at'
  ]) {
    assert.match(SQL, new RegExp(`^\\s*${column}\\s`, 'm'), `${column} is missing`);
  }
});

test('the lexical index uses the same configuration the knowledge side does', () => {
  // Accent-insensitive French, and it must be the SAME config at index and query
  // time or `retractation` and `rétractation` stop finding each other.
  assert.match(SQL, /to_tsvector\('public\.french_unaccent', coalesce\(phrasing_text, ''\)\)/);
});

test('the vector column is the right width for the embedding model', () => {
  assert.match(SQL, /embedding vector\(1536\)/);
  assert.match(SQL, /embedding_dimensions is null or embedding_dimensions = 1536/);
});

// --- what a matched rule may do ----------------------------------------------

test('route accepts every verdict except the one that would loosen', () => {
  // THE TIGHTEN-ONLY GUARANTEE, asserted as a RELATIONSHIP rather than as a
  // hard-coded pair. Written as a literal list, adding a fourth verdict to
  // case-file.mjs would leave this test passing while the new verdict was
  // silently un-routable; written this way it fails and someone decides.
  const clause = checkClause(SQL, 'support_answers_route_check');
  assert.ok(clause, 'the constraint is missing');
  assert.deepEqual(
    literalsIn(clause),
    VERDICTS.filter((v) => v !== 'answerable').sort()
  );
  assert.ok(!literalsIn(clause).includes('answerable'), 'a rule must never be able to declare a ticket safe');
});

test('ask accepts exactly the facts MISSING_FIELDS owns a sentence for', () => {
  // Same drift guard as requirement_needs. A key here that case-file.mjs cannot
  // word would be a rule asking a question nothing can write.
  const clause = checkClause(SQL, 'support_answers_ask_check');
  assert.ok(clause, 'the constraint is missing');
  assert.deepEqual(literalsIn(clause), Object.keys(MISSING_FIELDS).sort());
});

test('a rule that asks must also route to the customer', () => {
  // `draftDecision` refuses a `needs_customer_input` verdict with nothing named
  // to ask (`nothing_to_ask`), and the mirror case — something to ask with a
  // verdict that does not permit asking — would strand the question. The schema
  // makes the pair impossible to author.
  const clause = checkClause(SQL, 'support_answers_ask_needs_route_check');
  assert.ok(clause, 'the constraint is missing');
  // `cardinality(ask) = 0` since `ask` became a list. The column is `not null
  // default '{}'`, so "asks nothing" has exactly one representation — the
  // singular column was nullable, and an empty array beside a null would have
  // been two ways to say it, which is how the bug below happened in the first
  // place.
  assert.match(clause, /cardinality\(ask\) = 0 or route is not distinct from 'needs_customer_input'/);
  // NOT `route = '…'`. That form is NULL when route is null, `false or NULL` is
  // NULL, and a CHECK evaluating to NULL passes — so the obvious clause accepted
  // exactly the row it exists to refuse. Caught by inserting one against the
  // live table; asserted here so it cannot be simplified back.
  assert.ok(!/or route = /.test(clause), 'the two-valued form silently accepts a null route');
});

test('a pinned article is a real reference, and losing it never loses the rule', () => {
  // Unlike `offer_code`, which cannot be a foreign key because the Shopify sync
  // rewrites `promotions` under it. These rows are ours, so the reference is
  // enforced -- and `set null` rather than cascade, because deleting an article
  // must not delete every rule that cited it.
  const body = SQL.split('create table public.support_answers')[1].split('\n);')[0];
  assert.match(
    body,
    /knowledge_document_id uuid references public\.knowledge_documents\(id\) on delete set null/i
  );
});

test('collection mode defaults to the behaviour that existed before it', () => {
  // Shipping the planner must change no ticket. The default IS the safety
  // property: a situation collects by model until a person opts it in, and the
  // check is what stops a third value being invented in a migration.
  const body = SQL.split('create table public.support_exemplars')[1].split('\n);')[0];
  assert.match(body, /collection_mode text not null default 'model'/i);
  assert.deepEqual(
    literalsIn(checkClause(SQL, 'support_exemplars_collection_mode_check')).sort(),
    ['model', 'rule_directed']
  );
});

test('a rule may name a situation, and is not required to', () => {
  // Nullable is the load-bearing part: a rule naming only conditions still fires
  // when no exemplar matched, so coverage does not depend on the matcher.
  assert.match(SQL, /^\s*situation_key text,/m);
});

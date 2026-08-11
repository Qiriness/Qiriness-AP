import assert from 'node:assert/strict';
import test from 'node:test';

import { NEED_KEYS } from '../../agent/src/investigation/evidence-rules.mjs';
import { REQUEST_KINDS, TICKET_SUBJECTS } from '../../scripts/lib/support-taxonomy.mjs';

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

// --- retrieval ---------------------------------------------------------------

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

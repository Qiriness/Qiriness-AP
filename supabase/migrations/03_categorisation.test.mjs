import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SUBJECTS,
  REQUEST_KINDS,
  KNOWLEDGE_CATEGORIES,
  CONFIDENCE_LEVELS,
  REPLY_LANGUAGES,
  HAPPINESS_SCORES,
  defaultLevel
} from '../../scripts/lib/support-taxonomy.mjs';

const migration = readFileSync(new URL('./03_categorisation.sql', import.meta.url), 'utf8');

// The migration spells the vocabulary out in SQL (a check constraint cannot
// import a JS module), so these tests are what stop the two drifting apart.

function constraintBody(name) {
  return migration.match(
    new RegExp(`add constraint ${name} check \\(([\\s\\S]*?)\\n {2}\\)`, 'i')
  )?.[1];
}

test('the baseline creates schema, never migrates data', () => {
  // The knowledge-category renames and the needs_categorisation backfill were
  // one-off statements against dev. A database built from these files has no
  // rows to migrate, so their return here would be a no-op at best.
  for (const line of migration.split('\n').filter((l) => !l.trim().startsWith('--'))) {
    assert.doesNotMatch(line, /^\s*(update|insert|delete)\s+/i, line);
  }
});

test('it only extends tables 01 already created', () => {
  // 03 runs last precisely because it alters the knowledge and ticket tables.
  // The one table it creates is the review set, which is its own artefact.
  assert.deepEqual([...migration.matchAll(/create table public\.(\w+)/gi)].map((m) => m[1]), [
    'categorisation_review'
  ]);
});

// --- knowledge side ---------------------------------------------------------

test('knowledge_documents.category is constrained to every taxonomy value', () => {
  const constraint = constraintBody('knowledge_documents_category_check');
  assert.ok(constraint, 'expected a category check constraint');
  for (const category of KNOWLEDGE_CATEGORIES) {
    assert.ok(constraint.includes(`'${category}'`), `missing '${category}'`);
  }
  assert.match(constraint, /category is null or/i, 'an uncategorised article must stay valid');
});

// --- ticket side ------------------------------------------------------------

test('both request_kind columns exist', () => {
  assert.match(migration, /add column request_kind text/i);
  assert.match(migration, /add column secondary_request_kind text/i);
});

test('both subject columns are constrained to the 14 ticket subjects only', () => {
  for (const name of ['tickets_category_check', 'tickets_secondary_category_check']) {
    const constraint = constraintBody(name);
    assert.ok(constraint, `expected ${name}`);
    for (const subject of SUBJECTS) {
      assert.ok(constraint.includes(`'${subject}'`), `${name} is missing '${subject}'`);
    }
    // Knowledge-only shapes must NOT be valid ticket subjects.
    assert.ok(!constraint.includes("'faq'"), `${name} should not allow faq`);
    assert.ok(!constraint.includes("'brand_story'"), `${name} should not allow brand_story`);
  }
});

test('both kind columns are constrained to the four kinds', () => {
  for (const name of ['tickets_request_kind_check', 'tickets_secondary_request_kind_check']) {
    const constraint = constraintBody(name);
    assert.ok(constraint, `expected ${name}`);
    for (const kind of REQUEST_KINDS) {
      assert.ok(constraint.includes(`'${kind}'`), `${name} is missing '${kind}'`);
    }
  }
});

test('a secondary kind without a secondary subject is forbidden', () => {
  assert.match(
    migration,
    /add constraint tickets_secondary_pair_check check \(\s*secondary_request_kind is null or secondary_category is not null\s*\)/i
  );
});

test('the queue filter on subject + kind is indexed', () => {
  assert.match(
    migration,
    /create index tickets_shop_category_kind_idx\s+on public\.tickets \(shop_id, category, request_kind\)/i
  );
});

// --- level semantics --------------------------------------------------------

test('level 4 is documented as a severity judgement, not a subject', () => {
  const comment = migration.match(
    /comment on column public\.tickets\.level is\s+'([\s\S]*?)';/i
  )?.[1];
  assert.ok(comment, 'expected a level column comment');
  assert.match(comment, /SEVERITY judgement/i);
  assert.match(comment, /threat of legal action/i);
  assert.match(comment, /hospitalisation/i);
  assert.match(comment, /grave injury/i);
  // The rule this replaced. Its return would make the level mean "this topic"
  // rather than "this is serious" and refill the manager queue with routine mail.
  assert.doesNotMatch(comment, /cosmetovigilance is always/i);
});

test('the documented rule matches the code: no subject derives level 4', () => {
  for (const subject of SUBJECTS) {
    for (const kind of REQUEST_KINDS) {
      assert.notEqual(defaultLevel(subject, kind), 4, `${subject}/${kind}`);
    }
  }
});

// --- re-categorisation ------------------------------------------------------

test('adds the pending flag and the three signal columns', () => {
  assert.match(migration, /add column needs_categorisation boolean not null default true/i);
  assert.match(migration, /add column categorised_at timestamptz/i);
  assert.match(migration, /add column categorisation_confidence text/i);
  assert.match(migration, /add column language text/i);
  assert.match(migration, /add column happiness smallint/i);
});

test('the pending flag defaults to true, so a new ticket is never invisible', () => {
  // Default false would let a ticket be inserted in a state the categoriser does
  // not select, and it would sit unlabelled forever.
  assert.match(migration, /needs_categorisation boolean not null default true/i);
});

test('the pending query is indexed, partially', () => {
  // Steady state is "almost everything is already categorised", so a full index
  // on the flag would be mostly dead weight.
  assert.match(
    migration,
    /create index tickets_pending_categorisation_idx\s+on public\.tickets \(shop_id, first_message_at\)\s+where needs_categorisation/i
  );
});

test('confidence is constrained to the taxonomy values', () => {
  const constraint = constraintBody('tickets_categorisation_confidence_check');
  assert.ok(constraint, 'expected a confidence check constraint');
  for (const value of CONFIDENCE_LEVELS) {
    assert.ok(constraint.includes(`'${value}'`), `missing '${value}'`);
  }
  // The clause wraps across two lines, hence the loose gap.
  assert.match(constraint, /is null\s+or/i, 'an uncategorised ticket has no confidence yet');
});

test('language is constrained to the languages the desk can reply in', () => {
  const constraint = constraintBody('tickets_language_check');
  assert.ok(constraint, 'expected a language check constraint');
  for (const code of REPLY_LANGUAGES) {
    assert.ok(constraint.includes(`'${code}'`), `missing '${code}'`);
  }
  assert.match(constraint, /is null or/i);
});

test('happiness covers exactly the 1-4 scale', () => {
  const constraint = constraintBody('tickets_happiness_check');
  assert.ok(constraint, 'expected a happiness check constraint');
  assert.match(constraint, /between 1 and 4/i);
  assert.equal(Math.min(...HAPPINESS_SCORES), 1);
  assert.equal(Math.max(...HAPPINESS_SCORES), 4);
});

test('the columns document why happiness is not wired to level', () => {
  // The rule lives in three places (taxonomy module, categoriser prompt, here);
  // the database comment is the copy a reader of the schema alone will find.
  const comment = migration.match(
    /comment on column public\.tickets\.happiness is\s+'([\s\S]*?)';/i
  )?.[1];
  assert.ok(comment, 'expected a happiness column comment');
  assert.match(comment, /NOT derived from it/i);
});

// --- review set -------------------------------------------------------------

test('the review set accepts exactly the labels the agent could produce', () => {
  // The constraint is what stops a reviewer's typo being counted as a model error.
  for (const name of [
    'categorisation_review_human_category_check',
    'categorisation_review_agent_category_check'
  ]) {
    const constraint = migration.match(
      new RegExp(`constraint ${name} check \\(([\\s\\S]*?)\\n {2}\\)`, 'i')
    )?.[1];
    assert.ok(constraint, `expected ${name}`);
    for (const subject of SUBJECTS) {
      assert.ok(constraint.includes(`'${subject}'`), `${name} is missing '${subject}'`);
    }
  }
});

test('the review set is blind: agent columns exist but are filled later', () => {
  const body = migration.match(
    /create table public\.categorisation_review \(([\s\S]*?)\n\);/i
  )?.[1] || '';
  for (const col of ['human_category', 'human_request_kind', 'human_level', 'reviewed_at']) {
    assert.match(body, new RegExp(col, 'i'), col);
  }
  for (const col of ['agent_category', 'agent_request_kind', 'agent_level']) {
    assert.match(body, new RegExp(col, 'i'), col);
  }
  assert.match(
    migration,
    /comment on column public\.categorisation_review\.agent_category is\s+'[\s\S]*?anchors the reviewer/i
  );
});

test('the review set minimises personal data and expires', () => {
  const body = migration.match(
    /create table public\.categorisation_review \(([\s\S]*?)\n\);/i
  )?.[1] || '';
  // Sender reduced to a domain: enough to tell a B2B enquiry from a consumer
  // one, not enough to identify the person.
  assert.match(body, /from_domain text/i);
  assert.doesNotMatch(body, /^\s*from_email\s+text/im);
  assert.match(body, /retention_delete_after timestamptz not null default \(now\(\) \+ interval '3 months'\)/i);
});

test('the review set is idempotent per sampled message', () => {
  assert.match(
    migration,
    /constraint categorisation_review_message_unique unique \(shop_id, graph_message_id\)/i
  );
});

test('the review set has RLS and an updated_at trigger', () => {
  assert.match(migration, /alter table public\.categorisation_review enable row level security/i);
  assert.match(
    migration,
    /create trigger categorisation_review_set_updated_at\s+before update on public\.categorisation_review/i
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { REPLY_LANGUAGES } from '../../scripts/lib/support-taxonomy.mjs';

import { ARTICLE_VERDICTS } from '../../agent/src/testing/article-check.mjs';

import { checkClause, columnsIn, literalsIn, read, tablesIn } from './_shared.test.mjs';

const SQL = read('08_testing');

test('it creates the rehearsal record, and nothing else', () => {
  assert.deepEqual(tablesIn(SQL), ['agent_test_runs']);
});

// --- what a rehearsal is NOT -------------------------------------------------

test('a run points at no ticket, message, investigation or draft', () => {
  // The property the whole feature rests on: the passes run against in-memory
  // stores, so a test writes none of those rows. A foreign key to any of them
  // would mean one had been written after all.
  const columns = columnsIn(SQL, 'agent_test_runs');
  for (const forbidden of [
    'ticket_id',
    'ticket_message_id',
    'trigger_message_id',
    'investigation_id',
    'draft_id'
  ]) {
    assert.ok(!columns.includes(forbidden), `agent_test_runs must not carry ${forbidden}`);
  }
  assert.doesNotMatch(SQL, /references public\.(tickets|ticket_messages|ticket_investigations|ticket_drafts)/);
});

test('the identity is a mask, and neither the address nor a hash', () => {
  // The operator types a real customer's address on a dev store. Only the mask
  // survives the run: the plaintext is obvious, and a hash would be a bare
  // identifier nothing here reads.
  const columns = columnsIn(SQL, 'agent_test_runs');
  assert.ok(columns.includes('requester_email_masked'));
  assert.ok(!columns.includes('requester_email'), 'the plaintext address must not be stored');
  assert.ok(!columns.includes('requester_email_hash'), 'a hash here would have no reader');
});

// --- the article assertion ---------------------------------------------------

test('the article verdict vocabulary matches the module that derives it', () => {
  // A check constraint cannot import a module; this is what stops the two
  // drifting. Five states because the four failures want four different fixes.
  assert.deepEqual(
    literalsIn(checkClause(SQL, 'agent_test_runs_article_verdict_check')),
    [...ARTICLE_VERDICTS].sort()
  );
});

test('an article verdict without an article is refused', () => {
  assert.match(
    checkClause(SQL, 'agent_test_runs_article_verdict_needs_document_check')
      .replace(/\s+/g, ' ')
      .trim(),
    /article_verdict is null or expect_document_id is not null/
  );
});

test('deleting an article keeps the evidence of how it behaved', () => {
  assert.match(
    SQL,
    /expect_document_id uuid references public\.knowledge_documents\(id\) on delete set null/
  );
});

// --- the memory --------------------------------------------------------------

test('it carries an ideal answer, and refuses half of one', () => {
  // The corpus side of ticket_draft_edits, for situations that can be invented.
  // A stamp with no text, or text with no stamp, means the save path wrote half
  // a row.
  const columns = columnsIn(SQL, 'agent_test_runs');
  assert.ok(columns.includes('ideal_body_text'));
  assert.ok(columns.includes('ideal_saved_at'));

  const clause = checkClause(SQL, 'agent_test_runs_ideal_body_check').replace(/\s+/g, ' ').trim();
  assert.match(clause, /ideal_body_text is null and ideal_saved_at is null/);
  assert.match(clause, /ideal_saved_at is not null/);
});

// --- the record --------------------------------------------------------------

test('the trace is an array', () => {
  assert.match(checkClause(SQL, 'agent_test_runs_trace_array_check'), /jsonb_typeof\(trace\) = 'array'/);
});

test('the flat columns index the trace so a list never has to parse one', () => {
  // trace is the largest column here. The history pane renders a row per run
  // from these instead.
  const columns = columnsIn(SQL, 'agent_test_runs');
  for (const summary of ['category', 'request_kind', 'level', 'verdict', 'gate_outcome']) {
    assert.ok(columns.includes(summary), `agent_test_runs should summarise ${summary}`);
  }
});

test('a gated run is a completed run, not a failure', () => {
  // "This would never have become a ticket" is the finding, not an error.
  assert.deepEqual(literalsIn(checkClause(SQL, 'agent_test_runs_status_check')), [
    'complete',
    'failed',
    'gated'
  ]);
});

test('the case-file verdicts are the same three the investigation issues', () => {
  assert.deepEqual(literalsIn(checkClause(SQL, 'agent_test_runs_verdict_check')), [
    'answerable',
    'needs_customer_input',
    'needs_human'
  ]);
});

test('the reply language vocabulary matches the rest of the schema', () => {
  assert.deepEqual(
    literalsIn(checkClause(SQL, 'agent_test_runs_language_check')),
    [...REPLY_LANGUAGES].sort()
  );
});

test('cost is recorded on the run and not in llm_usage', () => {
  // llm_usage answers what handling the real mailbox costs; rehearsal spend
  // folded into it would move the Agent panel's per-ticket figures with nothing
  // saying why. See DECISIONS.md.
  const columns = columnsIn(SQL, 'agent_test_runs');
  for (const column of ['input_tokens', 'output_tokens', 'total_tokens', 'call_count']) {
    assert.ok(columns.includes(column));
  }
});

test('an empty message is not a run', () => {
  assert.match(checkClause(SQL, 'agent_test_runs_body_text_check'), /btrim\(body_text\) <> ''/);
});

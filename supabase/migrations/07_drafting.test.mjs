import assert from 'node:assert/strict';
import test from 'node:test';

import { REPLY_LANGUAGES } from '../../scripts/lib/support-taxonomy.mjs';

import { checkClause, columnsIn, literalsIn, read, tablesIn } from './_shared.test.mjs';

const SQL = read('07_drafting');

test('it creates the draft and its edit log, and nothing else', () => {
  assert.deepEqual(tablesIn(SQL), ['ticket_drafts', 'ticket_draft_edits']);
});

// --- the edit log, which exists for a reason the drafts table cannot serve ----

test('an edit carries the model text it was an edit OF', () => {
  // ticket_drafts.body_text is replaced by the next drafting run while
  // approved_body_text is deliberately kept, so those two columns stop being a
  // pair the moment a draft is re-run. The snapshot is what makes the record
  // trustworthy as a learning signal.
  const columns = columnsIn(SQL, 'ticket_draft_edits');
  assert.ok(columns.includes('model_body_text'));
  assert.ok(columns.includes('human_body_text'));
});

test('an edit that changed nothing is refused', () => {
  // The most misleading training row possible: a pair implying the agent's text
  // needed correcting into itself.
  assert.match(
    checkClause(SQL, 'ticket_draft_edits_changed_check').replace(/\s+/g, ' ').trim(),
    /btrim\(human_body_text\) <> btrim\(model_body_text\)/
  );
});

test('the mailbox is declared as an edit source before anything writes it', () => {
  // Editing a review copy in Outlook is the intended second source; adding the
  // value later would be a constraint change on a populated table.
  assert.deepEqual(literalsIn(checkClause(SQL, 'ticket_draft_edits_source_check')), [
    'dashboard',
    'mailbox'
  ]);
});

// --- the idempotency key -----------------------------------------------------

test('a draft is keyed on the message it answers, not on the ticket', () => {
  // Per ticket, a customer's reply would overwrite the draft a human is
  // part-way through reviewing. Same rule, same reason, as
  // ticket_investigations.
  assert.match(SQL, /unique \(shop_id, trigger_message_id\)/);
});

test('the trigger message and the case file are both required', () => {
  // A draft with no case file cannot exist: the verdict decides what kind of
  // reply this is and the established claims are the only usable facts.
  assert.match(SQL, /trigger_message_id uuid not null\s+references public\.ticket_messages/);
  assert.match(SQL, /investigation_id uuid not null\s+references public\.ticket_investigations/);
});

// --- what the table refuses to hold ------------------------------------------

test('every verdict the investigation issues can be drafted from', () => {
  // needs_human was excluded here at first, on the reasoning that it produces no
  // customer-facing text. That was wrong: a ticket a person has to finish still
  // owes the customer an acknowledgement. What the verdict changes is what the
  // reply may DO, which is `disposition`.
  assert.deepEqual(literalsIn(checkClause(SQL, 'ticket_drafts_source_verdict_check')), [
    'answerable',
    'needs_customer_input',
    'needs_human'
  ]);
});

test('a draft is terminal or intermediary, and nothing else', () => {
  assert.deepEqual(literalsIn(checkClause(SQL, 'ticket_drafts_disposition_check')), [
    'intermediary',
    'terminal'
  ]);
});

test('a reply that resolved nothing can never be the end of the exchange', () => {
  // The constraint that stops a ticket auto-closing on an acknowledgement. Both
  // columns come from the same case file, so it can only fail if the derivation
  // is changed carelessly -- which is exactly when it would matter.
  assert.match(
    checkClause(SQL, 'ticket_drafts_human_is_intermediary_check').replace(/\s+/g, ' ').trim(),
    /source_verdict <> 'needs_human' or disposition = 'intermediary'/
  );
});

test('a question is waiting on an answer, so it is never terminal either', () => {
  assert.match(
    checkClause(SQL, 'ticket_drafts_question_is_intermediary_check').replace(/\s+/g, ' ').trim(),
    /source_verdict <> 'needs_customer_input' or disposition = 'intermediary'/
  );
});

test('level 4 is never drafted', () => {
  // allowedTools hands level 4 an empty registry and the ticket reaches a
  // person untouched; a level 4 row would mean that was bypassed upstream.
  assert.match(
    checkClause(SQL, 'ticket_drafts_level_check').replace(/\s+/g, ' ').trim(),
    /level between 1 and 3/
  );
});

test('an empty body is not a draft', () => {
  assert.match(checkClause(SQL, 'ticket_drafts_body_text_check'), /btrim\(body_text\) <> ''/);
});

test('the reply language vocabulary matches the ticket it answers', () => {
  // Mirrored from support-taxonomy.mjs, which a check constraint cannot import.
  assert.deepEqual(
    literalsIn(checkClause(SQL, 'ticket_drafts_language_check')),
    [...REPLY_LANGUAGES].sort()
  );
});

// --- the two bodies, which are the quality measurement -----------------------

test('the model output and the human rewrite are separate columns', () => {
  // Collapsing them would make every draft look perfect the moment somebody
  // fixed it -- which is exactly the number graduating auto-send depends on.
  const columns = columnsIn(SQL, 'ticket_drafts');
  assert.ok(columns.includes('body_text'));
  assert.ok(columns.includes('approved_body_text'));
});

test('the edited status has to carry the edit', () => {
  assert.match(
    checkClause(SQL, 'ticket_drafts_edited_has_body_check').replace(/\s+/g, ' ').trim(),
    /status <> 'edited' or btrim\(coalesce\(approved_body_text, ''\)\) <> ''/
  );
});

test('the human decision and the machine outcome are separate columns', () => {
  // A draft can be mechanically clean and still rejected, and a person may edit
  // one precisely because a check caught something. One enum could not say both.
  const columns = columnsIn(SQL, 'ticket_drafts');
  assert.ok(columns.includes('status'));
  assert.ok(columns.includes('checks_passed'));
});

test('the lifecycle names sending but nothing else in the file does', () => {
  // `sent` is declared so the lifecycle reads completely. There is no recipient
  // column, no address and no send action -- this table cannot reach a customer,
  // and that is the property the whole review channel rests on.
  assert.deepEqual(literalsIn(checkClause(SQL, 'ticket_drafts_status_check')), [
    'approved',
    'edited',
    'pending',
    'rejected',
    'sent'
  ]);
  const columns = columnsIn(SQL, 'ticket_drafts');
  for (const forbidden of ['to_email', 'recipient', 'recipient_email', 'reply_to', 'sent_at']) {
    assert.ok(!columns.includes(forbidden), `ticket_drafts must not carry ${forbidden}`);
  }
});

// --- what it records for the graduation decision -----------------------------

test('it records whether the level gate would have auto-sent', () => {
  // Cannot be answered retrospectively, so it is recorded from the first draft
  // onwards while DRAFT_ONLY keeps everything inert.
  assert.ok(columnsIn(SQL, 'ticket_drafts').includes('auto_send_eligible'));
});

test('the review stamp exists so one draft is not mailed twice', () => {
  assert.ok(columnsIn(SQL, 'ticket_drafts').includes('review_sent_at'));
  assert.match(
    SQL,
    /create index ticket_drafts_shop_review_pending_idx[\s\S]*?where review_sent_at is null/
  );
});

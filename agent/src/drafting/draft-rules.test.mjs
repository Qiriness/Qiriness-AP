import assert from 'node:assert/strict';
import test from 'node:test';

import { VERDICTS } from '../investigation/case-file.mjs';
import {
  AUTO_SEND_LEVELS,
  DRAFTABLE_VERDICTS,
  autoSendEligible,
  draftDecision,
  replyLanguage
} from './draft-rules.mjs';

const ANSWERABLE = { verdict: 'answerable', missing: [] };
const ASKS = { verdict: 'needs_customer_input', missing: [{ field: 'shopify_order_number' }] };

// --- which verdicts produce text ---------------------------------------------

test('exactly one verdict produces no customer-facing text', () => {
  // Stated against the investigation's own list so a fourth verdict cannot be
  // added there and silently default to draftable here.
  const draftable = Object.keys(DRAFTABLE_VERDICTS);
  assert.deepEqual(VERDICTS.filter((v) => !draftable.includes(v)), ['needs_human']);
});

test('an answerable case file drafts a reply', () => {
  assert.deepEqual(draftDecision({ investigation: ANSWERABLE, ticket: { level: 2 } }), {
    draft: true,
    kind: 'reply',
    reason: null
  });
});

test('needs_customer_input drafts the question', () => {
  assert.equal(draftDecision({ investigation: ASKS, ticket: { level: 2 } }).kind, 'question');
});

test('needs_human drafts nothing, and that is a normal state', () => {
  const decision = draftDecision({ investigation: { verdict: 'needs_human' }, ticket: {} });
  assert.equal(decision.draft, false);
  assert.equal(decision.reason, 'needs_human');
});

test('no case file is a reason of its own, not an error', () => {
  assert.equal(draftDecision({ investigation: null, ticket: {} }).reason, 'no_case_file');
});

test('level 4 is never drafted, whatever the verdict said', () => {
  // The tool layer already handed level 4 an empty registry; a case file on one
  // means the level moved afterwards, and the draft must still not be written.
  assert.equal(draftDecision({ investigation: ANSWERABLE, ticket: { level: 4 } }).reason, 'level_4');
});

test('a question with nothing to ask for is refused rather than invented', () => {
  const decision = draftDecision({
    investigation: { verdict: 'needs_customer_input', missing: [] },
    ticket: { level: 2 }
  });
  assert.equal(decision.reason, 'nothing_to_ask');
});

// --- the auto-send gate, which nothing acts on yet ---------------------------

test('only the levels designed to graduate are eligible', () => {
  assert.deepEqual(AUTO_SEND_LEVELS, [1, 2]);
  for (const level of [1, 2]) {
    assert.equal(autoSendEligible({ level, happiness: 1, checksPassed: true }), true);
  }
  for (const level of [3, 4, null, undefined]) {
    assert.equal(autoSendEligible({ level, happiness: 1, checksPassed: true }), false);
  }
});

test('an unhappy customer is never auto-answered, whatever the level', () => {
  // level is what WORK a ticket needs; happiness is how the customer feels. A
  // level 1 question asked furiously is still a level 1 question.
  assert.equal(autoSendEligible({ level: 1, happiness: 3, checksPassed: true }), false);
  assert.equal(autoSendEligible({ level: 1, happiness: 4, checksPassed: true }), false);
});

test('unknown feeling is not a happy one', () => {
  for (const happiness of [null, undefined, 'calm']) {
    assert.equal(autoSendEligible({ level: 1, happiness, checksPassed: true }), false);
  }
});

test('a draft that failed a check is not a candidate for sending itself', () => {
  assert.equal(autoSendEligible({ level: 1, happiness: 1, checksPassed: false }), false);
  // Nor an unchecked one: the flag has to be explicitly true.
  assert.equal(autoSendEligible({ level: 1, happiness: 1 }), false);
});

// --- language ----------------------------------------------------------------

test('the reply follows the ticket, and falls back to French', () => {
  assert.equal(replyLanguage({ language: 'en' }), 'en');
  assert.equal(replyLanguage({ language: null }), 'fr');
  assert.equal(replyLanguage(null), 'fr');
});

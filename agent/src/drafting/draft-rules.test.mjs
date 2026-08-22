import assert from 'node:assert/strict';
import test from 'node:test';

import { VERDICTS } from '../investigation/case-file.mjs';
import {
  AUTO_SEND_LEVELS,
  DISPOSITIONS,
  DRAFTABLE_VERDICTS,
  autoSendEligible,
  describesChase,
  draftDecision,
  draftDisposition,
  replyLanguage
} from './draft-rules.mjs';

const ANSWERABLE = { verdict: 'answerable', missing: [] };
const ASKS = { verdict: 'needs_customer_input', missing: [{ field: 'shopify_order_number' }] };

// --- which verdicts produce text ---------------------------------------------

test('every verdict produces customer-facing text', () => {
  // Stated against the investigation's own list so a fourth verdict cannot be
  // added there and silently default to draftable here.
  assert.deepEqual([...VERDICTS].sort(), Object.keys(DRAFTABLE_VERDICTS).sort());
});

test('an answerable case file drafts a reply', () => {
  assert.deepEqual(draftDecision({ investigation: ANSWERABLE, ticket: { level: 2 } }), {
    draft: true,
    kind: 'reply',
    disposition: 'terminal',
    reason: null
  });
});

test('needs_customer_input drafts the question', () => {
  assert.equal(draftDecision({ investigation: ASKS, ticket: { level: 2 } }).kind, 'question');
});

test('needs_human drafts an acknowledgement, and it is intermediary', () => {
  // The customer hears back; the colleague gets something to edit; the ticket
  // does not close, because a person still owes an answer.
  const decision = draftDecision({
    investigation: { verdict: 'needs_human', handoff: { action: 'rembourser' } },
    ticket: { level: 3 }
  });
  assert.equal(decision.draft, true);
  assert.equal(decision.kind, 'acknowledgement');
  assert.equal(decision.disposition, 'intermediary');
});

test('a verdict nothing issues drafts nothing', () => {
  const decision = draftDecision({ investigation: { verdict: 'wat' }, ticket: {} });
  assert.equal(decision.draft, false);
  assert.equal(decision.reason, 'unknown_verdict');
});

// --- terminal vs intermediary ------------------------------------------------

test('only an answer with no outstanding action ends the exchange', () => {
  assert.deepEqual([...DISPOSITIONS].sort(), ['intermediary', 'terminal']);
  assert.equal(draftDisposition({ verdict: 'answerable', handoff: null }), 'terminal');
});

test('a question is intermediary: the customer owes us an answer', () => {
  assert.equal(draftDisposition({ verdict: 'needs_customer_input' }), 'intermediary');
});

test('an acknowledgement is intermediary: a colleague owes them one', () => {
  assert.equal(draftDisposition({ verdict: 'needs_human', handoff: { action: 'x' } }), 'intermediary');
  // Even without one recorded -- the verdict alone says a person owns this.
  assert.equal(draftDisposition({ verdict: 'needs_human', handoff: null }), 'intermediary');
});

test('an answer that still leaves a human something to do is NOT terminal', () => {
  // The direction the two conditions could disagree in, and the dangerous one:
  // closing a ticket somebody still owes work on. No such case file exists on
  // the corpus today (49/49 needs_human carry a handoff, 0/15 answerable do),
  // which is exactly why the rule has to be written down rather than observed.
  assert.equal(
    draftDisposition({ verdict: 'answerable', handoff: { action: 'relancer le transporteur' } }),
    'intermediary'
  );
});

test('the decision carries the disposition, so the runner cannot re-derive it differently', () => {
  const decision = draftDecision({ investigation: ANSWERABLE, ticket: { level: 2 } });
  assert.equal(decision.disposition, 'terminal');
});

test('no case file is a reason of its own, not an error', () => {
  assert.equal(draftDecision({ investigation: null, ticket: {} }).reason, 'no_case_file');
});

test('a ticket linked as a duplicate is never drafted', () => {
  // THE ENTIRE POINT OF THE LINK. Both threads stay whole; what must not happen
  // is a customer who wrote once receiving two replies because their mail
  // arrived under two conversation ids.
  const decision = draftDecision({
    investigation: ANSWERABLE,
    ticket: { level: 2, duplicate_of_ticket_id: 'ticket-1' }
  });
  assert.equal(decision.draft, false);
  assert.equal(decision.reason, 'duplicate');
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

test('an acknowledgement is never auto-sent, whatever its level', () => {
  // The verdict says a person owns the next move, and the first thing they need
  // is the chance to answer properly rather than to follow an automated holding
  // note the customer has already read.
  for (const level of [1, 2]) {
    assert.equal(
      autoSendEligible({ level, happiness: 1, checksPassed: true, verdict: 'needs_human' }),
      false
    );
  }
});

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

// --- was the customer left waiting -------------------------------------------

const at = (n) => new Date(2026, 0, n).toISOString();

test('two inbound messages with no reply between them is a chase', () => {
  const { chased, unanswered } = describesChase([
    { direction: 'inbound', received_at: at(1) },
    { direction: 'inbound', received_at: at(3) }
  ]);
  assert.equal(chased, true);
  assert.equal(unanswered, 2);
});

test('a reply between them is a normal exchange, not a chase', () => {
  // A customer answering our question has two inbound messages and is owed no
  // apology. What makes it a chase is that nothing came back.
  const { chased } = describesChase([
    { direction: 'inbound', received_at: at(1) },
    { direction: 'outbound', sent_at: at(2) },
    { direction: 'inbound', received_at: at(3) }
  ]);
  assert.equal(chased, false);
});

test('it counts the longest unanswered run, not the total', () => {
  const { chased, unanswered } = describesChase([
    { direction: 'inbound', received_at: at(1) },
    { direction: 'outbound', sent_at: at(2) },
    { direction: 'inbound', received_at: at(3) },
    { direction: 'inbound', received_at: at(4) },
    { direction: 'inbound', received_at: at(5) }
  ]);
  assert.equal(chased, true);
  assert.equal(unanswered, 3);
});

test('order is taken from the timestamps, not the row order', () => {
  // Inbound carries received_at and our own replies carry sent_at, so a thread
  // read back unsorted must still resolve to the real sequence.
  const { chased } = describesChase([
    { direction: 'inbound', received_at: at(3) },
    { direction: 'inbound', received_at: at(1) },
    { direction: 'outbound', sent_at: at(2) }
  ]);
  assert.equal(chased, false);
});

test('a single message is never a chase', () => {
  assert.equal(describesChase([{ direction: 'inbound', received_at: at(1) }]).chased, false);
  assert.equal(describesChase([]).chased, false);
});

test('a chase spanning two tickets is seen once the threads are merged', () => {
  // The cross-ticket case: each thread alone shows a single inbound and looks
  // like a first contact. Merged, the run of consecutive inbound is what the
  // customer actually experienced — two messages, no reply.
  const earlier = [{ direction: 'inbound', received_at: '2026-07-01T09:00:00Z' }];
  const own = [{ direction: 'inbound', received_at: '2026-07-08T09:00:00Z' }];

  assert.equal(describesChase(own).chased, false);
  assert.equal(describesChase(earlier).chased, false);

  const merged = describesChase([...earlier, ...own]);
  assert.equal(merged.chased, true);
  assert.equal(merged.unanswered, 2);
});

test('a reply on the earlier ticket breaks the run and is not a chase', () => {
  const merged = describesChase([
    { direction: 'inbound', received_at: '2026-07-01T09:00:00Z' },
    { direction: 'outbound', received_at: '2026-07-02T09:00:00Z' },
    { direction: 'inbound', received_at: '2026-07-08T09:00:00Z' }
  ]);
  assert.equal(merged.chased, false);
});

test('a thread one of us opened gets no drafted reply', () => {
  // A colleague forwarding a customer's problem in is not a customer, and a
  // reply in the brand's customer voice is never the right output for them.
  const base = { verdict: 'answerable', established: [{}] };
  assert.equal(draftDecision({ investigation: base, ticket: {} }).draft, true);

  for (const label of ['internal', 'contractor']) {
    const decision = draftDecision({ investigation: base, ticket: { sender_label: label } });
    assert.equal(decision.draft, false);
    assert.equal(decision.reason, 'internal_sender');
  }
});

test('a consumer ticket carries no sender label and is unaffected', () => {
  const decision = draftDecision({
    investigation: { verdict: 'answerable', established: [{}] },
    ticket: { sender_label: null }
  });
  assert.equal(decision.draft, true);
});

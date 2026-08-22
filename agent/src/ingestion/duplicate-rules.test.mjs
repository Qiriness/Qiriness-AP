import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DUPLICATE_REASONS,
  IDENTICAL_BODY_WINDOW_MS,
  findDuplicate,
  normaliseBody
} from './duplicate-rules.mjs';

const at = (iso) => new Date(iso).toISOString();

const PRIOR = {
  ticket_id: 'ticket-1',
  internet_message_id: '<first@qiriness.com>',
  body_text: 'Bonjour, c’est normal que ma commande est toujours en mode non traité?',
  received_at: at('2026-07-31T14:27:57Z')
};

// --- the reply chain ---------------------------------------------------------

test('In-Reply-To naming a stored message links the conversation', () => {
  // Not a resemblance: the sending client is telling us which conversation this
  // belongs to.
  const hit = findDuplicate({
    candidate: { in_reply_to: '<first@qiriness.com>', body_text: 'autre chose', received_at: at('2026-08-05T09:00:00Z') },
    priorMessages: [PRIOR]
  });
  assert.deepEqual(hit, { ticketId: 'ticket-1', reason: 'reply_chain' });
});

test('a References chain links it too, not only the direct parent', () => {
  const hit = findDuplicate({
    candidate: {
      reference_ids: ['<older@qiriness.com>', '<first@qiriness.com>'],
      body_text: 'autre chose',
      received_at: at('2026-08-05T09:00:00Z')
    },
    priorMessages: [PRIOR]
  });
  assert.equal(hit.reason, 'reply_chain');
});

test('the reply chain works long after the identical-body window closes', () => {
  // A reply a fortnight later is still the same conversation. The window belongs
  // to the double-post rule alone.
  const hit = findDuplicate({
    candidate: { in_reply_to: '<first@qiriness.com>', body_text: 'x', received_at: at('2026-08-14T09:00:00Z') },
    priorMessages: [PRIOR]
  });
  assert.equal(hit.reason, 'reply_chain');
});

test('a chain naming nothing we hold is not a link', () => {
  assert.equal(
    findDuplicate({
      candidate: { in_reply_to: '<unknown@elsewhere.com>', body_text: 'x', received_at: at('2026-08-01T09:00:00Z') },
      priorMessages: [PRIOR]
    }),
    null
  );
});

// --- the double-post ---------------------------------------------------------

test('the real case: identical text one second apart', () => {
  // Bavita NOBIN, measured: same sender, same body, 14:27:57 and 14:27:58, two
  // Graph conversation ids.
  const hit = findDuplicate({
    candidate: { body_text: PRIOR.body_text, received_at: at('2026-07-31T14:27:58Z') },
    priorMessages: [PRIOR]
  });
  assert.deepEqual(hit, { ticketId: 'ticket-1', reason: 'identical_body' });
});

test('identical text days later is a chase, not a duplicate', () => {
  // THE WINDOW IS THE WHOLE RULE. A customer resending the same message is owed
  // an apology for the delay, not silence.
  assert.equal(
    findDuplicate({
      candidate: { body_text: PRIOR.body_text, received_at: at('2026-08-03T14:27:57Z') },
      priorMessages: [PRIOR]
    }),
    null
  );
});

test('the window is measured in both directions', () => {
  // Graph's delta is not chronological, so the twin can arrive first.
  const hit = findDuplicate({
    candidate: { body_text: PRIOR.body_text, received_at: at('2026-07-31T14:27:56Z') },
    priorMessages: [PRIOR]
  });
  assert.equal(hit.reason, 'identical_body');
});

test('whitespace and case do not make two emails different emails', () => {
  const hit = findDuplicate({
    candidate: {
      body_text: '  BONJOUR,   c’est normal que ma commande est toujours en mode non traité? ',
      received_at: at('2026-07-31T14:27:58Z')
    },
    priorMessages: [PRIOR]
  });
  assert.equal(hit.reason, 'identical_body');
});

test('a different message from the same sender is not a duplicate', () => {
  assert.equal(
    findDuplicate({
      candidate: { body_text: 'Bonjour, où en est mon remboursement ?', received_at: at('2026-07-31T14:27:58Z') },
      priorMessages: [PRIOR]
    }),
    null
  );
});

test('an empty body never matches, however close in time', () => {
  // Otherwise every empty-bodied notification would collapse into one ticket.
  assert.equal(
    findDuplicate({
      candidate: { body_text: '   ', received_at: at('2026-07-31T14:27:58Z') },
      priorMessages: [{ ...PRIOR, body_text: '' }]
    }),
    null
  );
});

test('an unparseable timestamp is not treated as inside the window', () => {
  assert.equal(
    findDuplicate({
      candidate: { body_text: PRIOR.body_text, received_at: 'not a date' },
      priorMessages: [PRIOR]
    }),
    null
  );
});

// --- the contract ------------------------------------------------------------

test('nothing is a duplicate of itself, and an empty pool links nothing', () => {
  assert.equal(findDuplicate({ candidate: { body_text: 'x' }, priorMessages: [] }), null);
  assert.equal(findDuplicate({}), null);
});

test('every reason it can emit is one the database accepts', () => {
  // Mirrors tickets_duplicate_reason_check; a value added here without the
  // constraint fails at the write.
  assert.deepEqual([...DUPLICATE_REASONS].sort(), ['identical_body', 'reply_chain']);
});

test('the window is an hour, far wider than the case and far narrower than a chase', () => {
  assert.equal(IDENTICAL_BODY_WINDOW_MS, 3600000);
});

test('normaliseBody collapses whitespace and case, and nothing else', () => {
  // Stripping punctuation or accents would start merging messages a person
  // would read as distinct.
  assert.equal(normaliseBody('  A   b\nC  '), 'a b c');
  assert.notEqual(normaliseBody('traité'), normaliseBody('traite'));
});

test('the body rule is order-independent, so a replay must filter the pool itself', () => {
  // NOT A BUG, AND A TRAP FOR ANY BACKFILL. At ingestion the candidate is by
  // definition the newer message, so comparing absolute elapsed time is safe and
  // makes the rule immune to Graph returning a delta page out of order.
  //
  // Replaying over stored history has no such guarantee. A pool containing
  // messages LATER than the candidate will happily match one, and the caller
  // would then link the older ticket as a duplicate of the newer — suppressing
  // the original instead of the copy. `run-duplicate-backfill.mjs` filters the
  // pool to strictly-earlier messages for exactly this reason.
  const candidate = {
    ticket_id: 'ticket-1',
    body_text: 'Bonjour, où est ma commande ?',
    received_at: '2026-07-01T10:00:00Z'
  };
  const laterTwin = {
    ticket_id: 'ticket-2',
    body_text: 'Bonjour, où est ma commande ?',
    received_at: '2026-07-01T10:30:00Z'
  };

  const hit = findDuplicate({ candidate, priorMessages: [laterTwin] });
  assert.equal(hit?.ticketId, 'ticket-2', 'the rule matches in either direction by design');

  // Which is why the caller, not the rule, decides what counts as prior.
  const at = Date.parse(candidate.received_at);
  const filtered = [laterTwin].filter((m) => Date.parse(m.received_at) < at);
  assert.equal(findDuplicate({ candidate, priorMessages: filtered }), null);
});

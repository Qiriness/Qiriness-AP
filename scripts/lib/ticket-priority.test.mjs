import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRIORITY_WEIGHTS,
  byPriorityDesc,
  contactPoints,
  explainPriority,
  levelPoints,
  priorityBand,
  scorePriority,
  waitDays,
  waitPoints
} from './ticket-priority.mjs';

const NOW = new Date('2026-08-15T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

/** A ticket nothing is urgent about: level 1, answered, first contact. */
const plain = (overrides = {}) => ({
  level: 1,
  waitingSince: null,
  inboundCount: 1,
  status: 'open',
  isVip: false,
  ...overrides
});

// --- the ordering the weights are supposed to produce -----------------------

test('level 4 outranks everything, whatever the other factors say', () => {
  // The one absolute in the score. A legal threat or grave harm is not something
  // an amount of ordinary urgency should ever be served before.
  const maxedOutLevel3 = plain({
    level: 3,
    waitingSince: daysAgo(400),
    inboundCount: 99,
    status: 'awaiting_human',
    isVip: true
  });
  const bareLevel4 = plain({ level: 4 });

  assert.ok(scorePriority(bareLevel4, NOW) > scorePriority(maxedOutLevel3, NOW));
  // And by a margin nothing can close: everything else tops out at 82.
  assert.ok(scorePriority(bareLevel4, NOW) - scorePriority(maxedOutLevel3, NOW) > 900);
});

test('a maxed-out level 2 does outrank a bare level 3 — weighted, not tiered', () => {
  // The deliberate consequence of weighting rather than strict tiering: the
  // alternative starves the oldest work in the lower band for ever.
  const chasedLevel2 = plain({
    level: 2,
    waitingSince: daysAgo(40),
    inboundCount: 5,
    isVip: true
  });
  const freshLevel3 = plain({ level: 3, waitingSince: daysAgo(0.01) });

  assert.equal(scorePriority(chasedLevel2, NOW), 69);
  assert.ok(scorePriority(chasedLevel2, NOW) > scorePriority(freshLevel3, NOW));
});

test('wait is the strongest ordinary factor below the level 4 band', () => {
  // The tuned queue should pull old waiting customers up hard, without letting
  // anything touch a level 4.
  const w = PRIORITY_WEIGHTS;
  assert.ok(w.waitMax > w.level[3]);
  assert.ok(w.level[3] > w.level[2]);
  assert.ok(w.level[2] > w.level[1]);
  assert.ok(w.waitMax > w.contactMax);
  assert.ok(w.contactMax > w.awaitingHuman);
  assert.ok(w.awaitingHuman > w.vip);
});

test('a waiting level 1 can overtake a bare level 3', () => {
  // That is now deliberate: the customer-wait factor is stronger than the level
  // spread, so an old unanswered low-level ticket does not sit under fresh work
  // forever.
  const oldLevel1 = plain({ level: 1, waitingSince: daysAgo(14) });
  const freshLevel3 = plain({ level: 3 });

  assert.equal(scorePriority(oldLevel1, NOW), 45);
  assert.equal(scorePriority(freshLevel3, NOW), 25);
  assert.ok(scorePriority(oldLevel1, NOW) > scorePriority(freshLevel3, NOW));
});

// --- customer wait ----------------------------------------------------------

test('a ticket we have answered is not waiting, whatever its age', () => {
  // THE difference from last_message_at, which advances on our own replies and
  // would report a ticket answered yesterday as waiting forty days.
  assert.equal(waitPoints(null, NOW), 0);
  assert.equal(scorePriority(plain({ level: 3, waitingSince: null }), NOW), 25);
});

test('wait is a diminishing curve, saturating at a fortnight', () => {
  const at = (d) => Math.round(waitPoints(daysAgo(d), NOW));
  assert.equal(at(1), 9);
  assert.equal(at(3), 18);
  assert.equal(at(7), 27);
  assert.equal(at(14), 35);
  // Past the cap it stops discriminating: late is late.
  assert.equal(at(40), 35);
  assert.equal(at(400), 35);
});

test('the first day is worth more than the fortieth', () => {
  // The whole reason the curve is logarithmic rather than linear.
  const firstDay = waitPoints(daysAgo(1), NOW) - waitPoints(daysAgo(0), NOW);
  const fortieth = waitPoints(daysAgo(40), NOW) - waitPoints(daysAgo(39), NOW);
  assert.ok(firstDay > fortieth);
  assert.equal(Math.round(fortieth), 0);
});

test('a timestamp in the future scores no wait, not a negative one', () => {
  // Clock skew between Graph and here is not hypothetical.
  const future = new Date(NOW.getTime() + 86_400_000).toISOString();
  assert.equal(waitDays(future, NOW), 0);
  assert.equal(waitPoints(future, NOW), 0);
});

test('an unparseable timestamp is treated as not waiting', () => {
  assert.equal(waitDays('not-a-date', NOW), 0);
  assert.equal(waitDays(undefined, NOW), 0);
});

test('a Date and its ISO string score identically', () => {
  const d = new Date(NOW.getTime() - 3 * 86_400_000);
  assert.equal(waitPoints(d, NOW), waitPoints(d.toISOString(), NOW));
});

// --- times contacted --------------------------------------------------------

test('contacts count the customer writing in, and cap at four', () => {
  assert.equal(contactPoints(1), 0, 'a first email is not chasing');
  assert.equal(contactPoints(2), 7);
  assert.equal(contactPoints(3), 11);
  assert.equal(contactPoints(4), 14);
  // Capped: the difference between six and seven is one conversation continuing.
  assert.equal(contactPoints(12), 14);
});

test('a ticket with no inbound message at all scores no contacts', () => {
  // Threads holding only our own replies exist — 11 of them on the measured
  // mailbox — and they have no customer waiting either.
  assert.equal(contactPoints(0), 0);
  assert.equal(contactPoints(null), 0);
  assert.equal(contactPoints(undefined), 0);
});

// --- level ------------------------------------------------------------------

test('an uncategorised ticket scores as a level 2, not as a zero', () => {
  // Unknown severity is not low severity: bottom of the queue is how the one
  // that mattered gets missed.
  assert.equal(levelPoints(null), PRIORITY_WEIGHTS.level[2]);
  assert.equal(levelPoints(undefined), PRIORITY_WEIGHTS.level[2]);
  assert.ok(levelPoints(null) > levelPoints(1));
});

test('a level outside the taxonomy falls back rather than scoring zero', () => {
  assert.equal(levelPoints(9), PRIORITY_WEIGHTS.level[2]);
  assert.equal(levelPoints('3'), PRIORITY_WEIGHTS.level[3], 'a numeric string is still a level');
});

// --- the flags --------------------------------------------------------------

test('awaiting_human and VIP add, and only in that order of size', () => {
  const base = plain({ level: 2 });
  const human = scorePriority(plain({ level: 2, status: 'awaiting_human' }), NOW) - scorePriority(base, NOW);
  const vip = scorePriority(plain({ level: 2, isVip: true }), NOW) - scorePriority(base, NOW);

  assert.equal(human, 6);
  assert.equal(vip, 2);
  assert.ok(human > vip);
});

test('other statuses add nothing', () => {
  for (const status of ['open', 'awaiting_customer', 'forwarded', 'spam']) {
    assert.equal(scorePriority(plain({ level: 2, status }), NOW), 18, status);
  }
});

// --- the whole thing --------------------------------------------------------

test('the score is deterministic — same inputs, same number', () => {
  const ticket = plain({ level: 3, waitingSince: daysAgo(9), inboundCount: 3, isVip: true });
  const first = scorePriority(ticket, NOW);
  assert.equal(first, scorePriority(ticket, NOW));
  assert.equal(first, scorePriority({ ...ticket }, NOW));
});

test('the score is rounded, so tied rows do not shuffle between renders', () => {
  const a = plain({ level: 3, waitingSince: daysAgo(9) });
  const b = plain({ level: 3, waitingSince: new Date(NOW.getTime() - 9 * 86_400_000 - 500).toISOString() });
  // Half a second apart: the same score, not a flicker in the ordering.
  assert.equal(scorePriority(a, NOW), scorePriority(b, NOW));
});

test('explainPriority accounts for the whole score', () => {
  // A priority nobody can interrogate is a priority nobody trusts.
  const ticket = plain({ level: 3, waitingSince: daysAgo(7), inboundCount: 3, status: 'awaiting_human', isVip: true });
  const { score, parts } = explainPriority(ticket, NOW);

  assert.deepEqual(parts.map((p) => p.factor), ['level', 'wait', 'contacts', 'awaiting_human', 'vip']);
  const summed = parts.reduce((total, p) => total + p.points, 0);
  assert.ok(Math.abs(summed - score) < 0.15, `parts ${summed} should account for score ${score}`);
});

test('priority bands map scores to the row border colours', () => {
  assert.equal(priorityBand(10), 'low');
  assert.equal(priorityBand(44.9), 'low');
  assert.equal(priorityBand(45), 'medium');
  assert.equal(priorityBand(69.9), 'medium');
  assert.equal(priorityBand(70), 'high');
  assert.equal(priorityBand(1000), 'high');
});

test('byPriorityDesc puts the most urgent first and breaks ties on the longer wait', () => {
  const tickets = [
    plain({ level: 1 }),
    plain({ level: 3, waitingSince: daysAgo(20) }),
    plain({ level: 4 }),
    // Same score as the level 3 above (both saturated), longer wait wins.
    plain({ level: 3, waitingSince: daysAgo(60) })
  ];

  const order = [...tickets].sort(byPriorityDesc(NOW));
  assert.equal(order[0].level, 4);
  assert.equal(Math.round(waitDays(order[1].waitingSince, NOW)), 60);
  assert.equal(Math.round(waitDays(order[2].waitingSince, NOW)), 20);
  assert.equal(order[3].level, 1);
});

test('sorting is stable enough to be a queue: no ticket outranks itself', () => {
  const ticket = plain({ level: 2, waitingSince: daysAgo(5), inboundCount: 2 });
  assert.equal(byPriorityDesc(NOW)(ticket, { ...ticket }), 0);
});

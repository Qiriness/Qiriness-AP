import assert from 'node:assert/strict';
import test from 'node:test';

import {
  byPriorityDesc,
  contactPoints,
  determinePriorityBand,
  explainPriority,
  priorityBand,
  scorePriority,
  waitDays,
  waitPoints
} from './ticket-priority.mjs';

const NOW = new Date('2026-09-26T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const plain = (overrides = {}) => ({
  level: 1,
  situationKey: 'D-07',
  orderState: 'unknown',
  waitingSince: null,
  inboundCount: 1,
  status: 'open',
  isVip: false,
  ...overrides
});

test('pre-fulfilment address, cancellation and modification branches are High', () => {
  for (const situationKey of ['O-12', 'O-13', 'O-14']) {
    const decision = determinePriorityBand(plain({ situationKey, orderState: 'not_dispatched' }));
    assert.equal(decision.band, 'high', situationKey);
    assert.match(decision.reason, /check immediately/i);
  }
});

test('not dispatched requests Deret verification and does not claim changes remain possible', () => {
  const { reason } = determinePriorityBand(plain({ situationKey: 'O-12', orderState: 'not_dispatched' }));
  assert.match(reason, /whether Deret can still intervene/i);
  assert.doesNotMatch(reason, /can be changed|still possible/i);
});

test('missing fulfilment information preserves provisional urgency', () => {
  for (const orderState of [undefined, 'unknown']) {
    assert.equal(determinePriorityBand(plain({ situationKey: 'O-13', orderState })).band, 'high');
  }
});

test('fulfilment removes the original action-window urgency', () => {
  for (const orderState of ['dispatched', 'delivered', 'cancelled']) {
    assert.equal(determinePriorityBand(plain({ situationKey: 'O-12', orderState })).band, 'low', orderState);
  }
});

test('completion removes action urgency without hiding a separate service failure', () => {
  assert.equal(
    determinePriorityBand(plain({ situationKey: 'O-13', orderState: 'not_dispatched', actionCompleted: true })).band,
    'low'
  );
  assert.equal(
    determinePriorityBand(plain({ situationKey: 'O-13', actionCompleted: true, serviceFailure: true })).band,
    'medium'
  );
});

test('conditional deadline cases are High only while action is open', () => {
  const cases = [
    { actionKind: 'duplicate_order_cancellation', deadlineImminent: true },
    { actionKind: 'item_or_gift_correction', deadlineImminent: true },
    { parcelCollectionDeadline: true, deadlineImminent: true },
    { returnInstructionsBlocked: true, deadlineImminent: true },
    { logisticsAwaitingInstructions: true }
  ];
  for (const facts of cases) {
    assert.equal(determinePriorityBand(plain(facts)).band, 'high');
    assert.equal(determinePriorityBand(plain({ ...facts, actionCompleted: true })).band, 'low');
  }
});

test('established service failures are Medium and routine advice is Low', () => {
  for (const situationKey of ['D-02', 'D-03', 'D-05', 'D-06', 'D-08', 'D-36', 'D-37', 'P-20']) {
    assert.equal(determinePriorityBand(plain({ situationKey })).band, 'medium', situationKey);
  }
  assert.equal(determinePriorityBand(plain({ situationKey: 'D-07' })).band, 'low');
  assert.equal(determinePriorityBand(plain({ situationKey: 'R-21' })).band, 'low');
});

test('generic dispatch and non-receipt cases become Medium only after their applicable threshold', () => {
  assert.equal(determinePriorityBand(plain({ situationKey: 'O-09', dispatchExcessWorkingDays: 0 })).band, 'low');
  assert.equal(determinePriorityBand(plain({ situationKey: 'O-09', dispatchExcessWorkingDays: 1 })).band, 'medium');
  assert.equal(determinePriorityBand(plain({ situationKey: 'D-01', deliveryExcessWorkingDays: 0 })).band, 'low');
  assert.equal(determinePriorityBand(plain({ situationKey: 'D-01', deliveryExcessWorkingDays: 1 })).band, 'medium');
});

test('missing timing information does not lower a potentially overdue case', () => {
  assert.equal(determinePriorityBand(plain({ situationKey: 'O-09', dispatchExcessWorkingDays: null })).band, 'medium');
  assert.equal(determinePriorityBand(plain({ situationKey: 'D-01', deliveryExcessWorkingDays: null })).band, 'medium');
});

test('an old fulfilled order alone is not an undelivered or lost parcel', () => {
  const oldOrder = plain({ situationKey: 'D-07', orderState: 'dispatched', deliveryExcessWorkingDays: 50 });
  assert.equal(determinePriorityBand(oldOrder).band, 'low');
});

test('VIP, message count and age cannot promote a routine enquiry to High', () => {
  const routine = plain({ isVip: true, inboundCount: 999, waitingSince: daysAgo(400), status: 'awaiting_human' });
  assert.equal(priorityBand(scorePriority(routine, NOW)), 'low');
  assert.ok(scorePriority(routine, NOW) < 100);
});

test('VIP has no score contribution', () => {
  assert.equal(scorePriority(plain({ isVip: false }), NOW), scorePriority(plain({ isVip: true }), NOW));
  assert.ok(!explainPriority(plain({ isVip: true }), NOW).parts.some((part) => part.factor === 'vip'));
});

test('within-band facts order tickets without crossing the band boundary', () => {
  const fresh = plain({ situationKey: 'D-02' });
  const chased = plain({ situationKey: 'D-02', waitingSince: daysAgo(40), inboundCount: 8, status: 'awaiting_human' });
  assert.ok(scorePriority(chased, NOW) > scorePriority(fresh, NOW));
  assert.equal(priorityBand(scorePriority(fresh, NOW)), 'medium');
  assert.equal(priorityBand(scorePriority(chased, NOW)), 'medium');
});

test('level 4 remains High regardless of other facts', () => {
  assert.equal(determinePriorityBand(plain({ level: 4 })).band, 'high');
});

test('unknown situations remain Medium until triaged, not silently Low', () => {
  assert.equal(determinePriorityBand(plain({ situationKey: null })).band, 'medium');
});

test('wait and contact curves remain deterministic and capped', () => {
  assert.equal(Math.round(waitPoints(daysAgo(1), NOW)), 9);
  assert.equal(Math.round(waitPoints(daysAgo(14), NOW)), 35);
  assert.equal(Math.round(waitPoints(daysAgo(400), NOW)), 35);
  assert.equal(contactPoints(1), 0);
  assert.equal(contactPoints(2), 7);
  assert.equal(contactPoints(3), 11);
  assert.equal(contactPoints(12), 14);
  assert.equal(waitDays('not-a-date', NOW), 0);
});

test('same facts and evaluation time produce exactly the same result and explanation', () => {
  const ticket = plain({ situationKey: 'D-01', deliveryExcessWorkingDays: 4, waitingSince: daysAgo(9), inboundCount: 3 });
  assert.equal(scorePriority(ticket, NOW), scorePriority({ ...ticket }, NOW));
  assert.deepEqual(explainPriority(ticket, NOW), explainPriority({ ...ticket }, NOW));
});

test('priority bands retain the High, Medium and Low UI contract', () => {
  assert.equal(priorityBand(99.9), 'low');
  assert.equal(priorityBand(100), 'medium');
  assert.equal(priorityBand(199.9), 'medium');
  assert.equal(priorityBand(200), 'high');
});

test('byPriorityDesc orders by band, then within-band score, then wait', () => {
  const low = plain();
  const medium = plain({ situationKey: 'D-02' });
  const high = plain({ situationKey: 'O-12', orderState: 'unknown' });
  assert.deepEqual([...[low, high, medium]].sort(byPriorityDesc(NOW)), [high, medium, low]);
});

test('a band a person pinned holds, except over level 4', () => {
  assert.equal(determinePriorityBand({ level: 1, pinnedBand: 'high' }).band, 'high');
  assert.equal(determinePriorityBand({ level: 4, pinnedBand: 'low' }).band, 'high');
  assert.equal(determinePriorityBand({ level: 1, pinnedBand: 'bogus' }).band, determinePriorityBand({ level: 1 }).band);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { AUTO_CLOSE_AFTER_DAYS, runAutoClose, shouldAutoClose } from './auto-close.mjs';

const NOW = new Date('2026-08-03T12:00:00.000Z');

/** `days` ago, relative to NOW. */
function ago(days) {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function ticket(overrides = {}) {
  return {
    id: 't1',
    status: 'open',
    level: 2,
    last_message_at: ago(30),
    deleted_at: null,
    needs_categorisation: false,
    metadata: {},
    ...overrides
  };
}

test('closes a ticket idle for longer than the window', () => {
  assert.equal(shouldAutoClose(ticket({ last_message_at: ago(22) }), { now: NOW }), true);
});

test('leaves a ticket that is still inside the window', () => {
  assert.equal(shouldAutoClose(ticket({ last_message_at: ago(20) }), { now: NOW }), false);
});

test('the boundary itself closes, so "3 weeks" means 21 days not 22', () => {
  assert.equal(AUTO_CLOSE_AFTER_DAYS, 21);
  assert.equal(shouldAutoClose(ticket({ last_message_at: ago(21) }), { now: NOW }), true);
});

test('level 4 never auto-closes, however stale', () => {
  // Level 4 is severity, not subject — a legal threat or a hospitalisation. On
  // those, silence is the opposite of resolved.
  assert.equal(shouldAutoClose(ticket({ level: 4, last_message_at: ago(400) }), { now: NOW }), false);
});

test('level 3 does auto-close — only level 4 is exempt', () => {
  assert.equal(shouldAutoClose(ticket({ level: 3, last_message_at: ago(60) }), { now: NOW }), true);
});

test('an uncategorised ticket closes rather than being spared by a null level', () => {
  // The bug this guards: filtering `level != 4` in SQL drops NULL rows too,
  // which would silently exempt the largest group in the table.
  assert.equal(shouldAutoClose(ticket({ level: null, last_message_at: ago(60) }), { now: NOW }), true);
});

test('a ticket still queued for the categoriser is never closed', () => {
  // The categoriser selects on status = 'open', so closing one that is still
  // flagged drops it out of that queue permanently and freezes it as
  // uncategorised. Deferring the close costs a few polls; getting it wrong is
  // unrecoverable without a customer reply.
  assert.equal(
    shouldAutoClose(ticket({ needs_categorisation: true, last_message_at: ago(200) }), { now: NOW }),
    false
  );
});

test('a ticket the categoriser has finished with closes normally', () => {
  // Including one it could never classify: the runner clears the flag on a
  // thread holding no customer message, so those still retire on schedule.
  assert.equal(
    shouldAutoClose(
      ticket({ needs_categorisation: false, category: null, level: null, last_message_at: ago(200) }),
      { now: NOW }
    ),
    true
  );
});

test('already-finished tickets are left alone, so closed_at is not rewritten', () => {
  for (const status of ['closed', 'resolved']) {
    assert.equal(shouldAutoClose(ticket({ status, last_message_at: ago(90) }), { now: NOW }), false, status);
  }
});

test('a soft-deleted ticket is never touched', () => {
  assert.equal(
    shouldAutoClose(ticket({ deleted_at: ago(1), last_message_at: ago(90) }), { now: NOW }),
    false
  );
});

test('a ticket with no activity timestamp is left alone, not treated as ancient', () => {
  assert.equal(shouldAutoClose(ticket({ last_message_at: null }), { now: NOW }), false);
  assert.equal(shouldAutoClose(ticket({ last_message_at: 'not-a-date' }), { now: NOW }), false);
});

test('runAutoClose closes the stale ones and counts the exempt', async () => {
  const closed = [];
  const store = {
    findInactive: async () => [
      ticket({ id: 'stale-1', last_message_at: ago(40) }),
      ticket({ id: 'stale-2', level: 3, last_message_at: ago(25) }),
      ticket({ id: 'severe', level: 4, last_message_at: ago(99) })
    ],
    closeTicket: async (t) => {
      closed.push(t.id);
    }
  };

  const totals = await runAutoClose({ store, shopId: 's1', now: NOW });

  assert.deepEqual(closed, ['stale-1', 'stale-2']);
  assert.deepEqual(totals, { considered: 3, closed: 2, exempt: 1, failed: 0 });
});

test('dry run decides everything and writes nothing', async () => {
  let writes = 0;
  const store = {
    findInactive: async () => [ticket({ last_message_at: ago(40) })],
    closeTicket: async () => {
      writes += 1;
    }
  };

  const totals = await runAutoClose({ store, shopId: 's1', now: NOW, dryRun: true });

  assert.equal(writes, 0);
  assert.equal(totals.closed, 1, 'still reports what it would have closed');
});

test('one failing row does not stop the pass', async () => {
  const closed = [];
  const store = {
    findInactive: async () => [
      ticket({ id: 'a', last_message_at: ago(40) }),
      ticket({ id: 'boom', last_message_at: ago(40) }),
      ticket({ id: 'c', last_message_at: ago(40) })
    ],
    closeTicket: async (t) => {
      if (t.id === 'boom') throw new Error('conflict');
      closed.push(t.id);
    }
  };

  const totals = await runAutoClose({ store, shopId: 's1', now: NOW, logger: { warn() {} } });

  assert.deepEqual(closed, ['a', 'c']);
  assert.equal(totals.failed, 1);
  assert.equal(totals.closed, 2);
});

test('the cutoff handed to the store matches the window', async () => {
  let seen = null;
  const store = {
    findInactive: async (_shopId, cutoff) => {
      seen = cutoff;
      return [];
    },
    closeTicket: async () => {}
  };

  await runAutoClose({ store, shopId: 's1', now: NOW, afterDays: 21 });

  assert.equal(seen.toISOString(), '2026-07-13T12:00:00.000Z');
});

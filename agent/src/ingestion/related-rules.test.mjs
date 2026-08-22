import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MIN_RELATED_GAP_MS,
  RELATED_THRESHOLD,
  cosine,
  findRelated,
  toVector
} from './related-rules.mjs';

/** A unit vector pointing mostly along `axis`, with `noise` spread elsewhere. */
function vector(axis, noise = 0) {
  const v = new Array(8).fill(noise);
  v[axis] = 1;
  return v;
}

const DAY = 86400000;
const NOW = Date.parse('2026-07-20T12:00:00Z');
const iso = (offset) => new Date(NOW + offset).toISOString();

const CANDIDATE = { ticket_id: 'ticket-2', embedding: vector(0), received_at: iso(0) };
const PRIOR = { ticket_id: 'ticket-1', embedding: vector(0), received_at: iso(-3 * DAY) };

test('cosine is 1 for the same direction and 0 for orthogonal', () => {
  assert.equal(cosine(vector(0), vector(0)), 1);
  assert.equal(cosine(vector(0), vector(1)), 0);
  assert.equal(cosine([0, 0], [1, 1]), 0);
  assert.equal(cosine(null, vector(0)), 0);
  assert.equal(cosine([1, 2, 3], [1, 2]), 0);
});

test('a pgvector string is read, and anything unparseable is null', () => {
  assert.deepEqual(toVector('[1,2,3]'), [1, 2, 3]);
  assert.deepEqual(toVector([1, 2]), [1, 2]);
  assert.equal(toVector('not json'), null);
  assert.equal(toVector(''), null);
  assert.equal(toVector(null), null);
  assert.equal(toVector('{"a":1}'), null);
});

test('a similar earlier message from the same sender is related', () => {
  const hit = findRelated({ candidate: CANDIDATE, priorMessages: [PRIOR] });
  assert.equal(hit.ticketId, 'ticket-1');
  assert.equal(hit.score, 1);
});

test('an unrelated message is not linked however recent', () => {
  const other = { ...PRIOR, embedding: vector(3) };
  assert.equal(findRelated({ candidate: CANDIDATE, priorMessages: [other] }), null);
});

test('the strongest match wins when several qualify', () => {
  const weaker = { ticket_id: 'ticket-0', embedding: vector(0, 0.12), received_at: iso(-5 * DAY) };
  const hit = findRelated({ candidate: CANDIDATE, priorMessages: [weaker, PRIOR] });
  assert.equal(hit.ticketId, 'ticket-1');
});

test('a match inside the duplicate window is left to the duplicate rules', () => {
  // THE HANDOFF. Under an hour is a double-post, and that decision belongs to
  // deterministic code whose consequence is silence — not to a similarity score.
  const tooSoon = { ...PRIOR, received_at: iso(-MIN_RELATED_GAP_MS + 1000) };
  assert.equal(findRelated({ candidate: CANDIDATE, priorMessages: [tooSoon] }), null);
});

test('a match older than the window is ignored', () => {
  const stale = { ...PRIOR, received_at: iso(-45 * DAY) };
  assert.equal(findRelated({ candidate: CANDIDATE, priorMessages: [stale] }), null);
});

test('a message is never related to its own ticket', () => {
  const sameTicket = { ...PRIOR, ticket_id: 'ticket-2' };
  assert.equal(findRelated({ candidate: CANDIDATE, priorMessages: [sameTicket] }), null);
});

test('a later message is not a prior', () => {
  const future = { ...PRIOR, received_at: iso(3 * DAY) };
  assert.equal(findRelated({ candidate: CANDIDATE, priorMessages: [future] }), null);
});

test('no embedding on either side means no opinion', () => {
  assert.equal(findRelated({ candidate: { ...CANDIDATE, embedding: null }, priorMessages: [PRIOR] }), null);
  assert.equal(
    findRelated({ candidate: CANDIDATE, priorMessages: [{ ...PRIOR, embedding: null }] }),
    null
  );
});

// --- the chase signal --------------------------------------------------------

test('an unanswered related prior is a chase', () => {
  // THE POINT OF THE MODULE. The customer wrote again, under a NEW ticket, and
  // heard nothing — invisible to the in-thread chase check, which only ever sees
  // one conversation.
  const hit = findRelated({ candidate: CANDIDATE, priorMessages: [PRIOR], outboundAt: [] });
  assert.equal(hit.chased, true);
});

test('a reply between the two means they were not left waiting', () => {
  const hit = findRelated({
    candidate: CANDIDATE,
    priorMessages: [PRIOR],
    outboundAt: [iso(-2 * DAY)]
  });
  assert.equal(hit.chased, false);
});

test('a reply outside the two messages does not count as answering', () => {
  // Before the first or after the second says nothing about this gap.
  const hit = findRelated({
    candidate: CANDIDATE,
    priorMessages: [PRIOR],
    outboundAt: [iso(-10 * DAY), iso(DAY)]
  });
  assert.equal(hit.chased, true);
});

test('the threshold is the caller\u2019s to raise but defaults to the measured one', () => {
  assert.equal(RELATED_THRESHOLD, 0.9);
  const soft = { ...PRIOR, embedding: vector(0, 0.12) }; // cosine ~0.953
  assert.ok(findRelated({ candidate: CANDIDATE, priorMessages: [soft] }));
  assert.equal(findRelated({ candidate: CANDIDATE, priorMessages: [soft], threshold: 0.99 }), null);
});

// --- the candidate pool ------------------------------------------------------

import { createRelatedLookup } from './related-rules.mjs';

function lookupHarness({ rows = {}, directory = { lookup: () => null } } = {}) {
  const calls = [];
  const select = async (_c, table, filters, columns) => {
    calls.push({ table, filters, columns });
    return rows[table] ?? [];
  };
  return {
    calls,
    lookup: createRelatedLookup({ supabase: {}, shopId: 'shop-1', select, senderDirectory: directory })
  };
}

test('a sender listed in the directory is never compared, and costs no query', async () => {
  // THE GATE THAT MAKES THE THRESHOLD USABLE. A retailer's weekly template
  // scores 0.994-0.998 against its own past orders — above every genuine
  // consumer match — so no threshold separates them and the sender must.
  const h = lookupHarness({ directory: { lookup: () => ({ label: 'retailer' }) } });
  const out = await h.lookup.priorMessages({
    requesterEmailHash: 'hash-1',
    fromEmail: 'orders@nocibe.fr'
  });

  assert.deepEqual(out, { priorMessages: [], outboundAt: [] });
  assert.equal(h.calls.length, 0, 'a listed sender should not reach the database');
});

test('an unlisted sender is a consumer and is compared', async () => {
  const h = lookupHarness({
    rows: {
      tickets: [{ id: 'ticket-1' }],
      ticket_messages: [
        { ticket_id: 'ticket-1', direction: 'inbound', received_at: 'x', embedding: '[1,0]' },
        { ticket_id: 'ticket-1', direction: 'inbound', received_at: 'y', embedding: null },
        { ticket_id: 'ticket-1', direction: 'outbound', received_at: 'z', embedding: null }
      ]
    }
  });
  const out = await h.lookup.priorMessages({
    requesterEmailHash: 'hash-1',
    fromEmail: 'someone@gmail.com'
  });

  // Un-embedded messages are dropped: they cannot be compared, and keeping them
  // would make the pool look larger than the evidence it holds.
  assert.equal(out.priorMessages.length, 1);
  assert.deepEqual(out.outboundAt, ['z']);
});

test('without a sender hash there is nothing to scope to, so nothing is compared', async () => {
  const h = lookupHarness();
  assert.deepEqual(await h.lookup.priorMessages({ fromEmail: 'a@b.com' }), {
    priorMessages: [],
    outboundAt: []
  });
  assert.equal(h.calls.length, 0);
});

test('a sender with no recent tickets asks for no messages', async () => {
  const h = lookupHarness({ rows: { tickets: [] } });
  const out = await h.lookup.priorMessages({ requesterEmailHash: 'h', fromEmail: 'a@b.com' });
  assert.deepEqual(out.priorMessages, []);
  assert.equal(h.calls.length, 1, 'the message query should be skipped entirely');
});

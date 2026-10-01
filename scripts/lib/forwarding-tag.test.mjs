import test from 'node:test';
import assert from 'node:assert/strict';

import { forwardingTag, situationForwarding } from './forwarding-tag.mjs';

const cosmeto = {
  categories: ['cosmetovigilance'],
  request_kinds: [],
  id: 'd1',
  label: 'Cosmétovigilance',
  forward_email: 'cosmetovigilance@example.com',
  active_since: '2026-09-29T14:42:20Z',
  timing: 'after_first_reply'
};
const routing = { outcome: 'forward', category: 'cosmetovigilance', destination_id: 'd1', destination_label: 'Cosmétovigilance' };
const base = { ticketCategory: 'cosmetovigilance', routing, destination: cosmeto, switchedOn: true };

test('a ticket waiting for our first reply says so', () => {
  assert.deepEqual(forwardingTag(base), { destination: 'Cosmétovigilance', state: 'after_first_reply', at: null });
});

test('an immediate destination is pending until the next pass', () => {
  assert.equal(forwardingTag({ ...base, destination: { ...cosmeto, timing: 'immediate' } }).state, 'pending');
});

test('a sent forward is shown with the label it was sent under, and its time', () => {
  const tag = forwardingTag({
    ...base,
    forwards: [
      { status: 'sent', destination_label: 'Cosmétovigilance', created_at: '2026-10-01T09:00:00Z' },
      { status: 'sent', destination_label: 'Cosmétovigilance', created_at: '2026-10-02T09:00:00Z' }
    ]
  });
  assert.deepEqual(tag, { destination: 'Cosmétovigilance', state: 'forwarded', at: '2026-10-02T09:00:00Z' });
});

test('what was sent stays tagged after the destination or the switch is turned off', () => {
  const forwards = [{ status: 'sent', destination_label: 'RH', created_at: '2026-10-01T09:00:00Z' }];
  assert.equal(forwardingTag({ ...base, forwards, destination: null, switchedOn: false }).state, 'forwarded');
});

test('a failed attempt with nothing sent is shown as failed', () => {
  assert.equal(forwardingTag({ ...base, forwards: [{ status: 'failed', created_at: '2026-10-01T09:00:00Z' }] }).state, 'failed');
});

test('nothing is promised when forwarding is off, the destination is off, or the ticket is kept', () => {
  assert.equal(forwardingTag({ ...base, switchedOn: false }), null);
  assert.equal(forwardingTag({ ...base, destination: { ...cosmeto, active_since: null } }), null);
  assert.equal(forwardingTag({ ...base, routing: { ...routing, outcome: 'keep' } }), null);
  assert.equal(forwardingTag({ ...base, routing: null }), null);
});

test('a decision taken on another category promises nothing until it is re-taken', () => {
  assert.equal(forwardingTag({ ...base, ticketCategory: 'product' }), null);
});

test('a situation in a category one destination takes is tagged with it and its timing', () => {
  assert.deepEqual(
    situationForwarding({ category: 'cosmetovigilance', requestKind: 'problem', destinations: [cosmeto], switchedOn: true }),
    { route: 'fixed', destinations: [{ label: 'Cosmétovigilance', timing: 'after_first_reply' }] }
  );
});

test('several destinations, or one checked against its description, are an agent choice', () => {
  const b2b = (id, label) => ({ ...cosmeto, id, label, categories: ['b2b'], timing: 'immediate' });
  const tag = situationForwarding({ category: 'b2b', destinations: [b2b('a', 'Export'), b2b('b', 'France')], switchedOn: true });
  assert.equal(tag.route, 'choose');
  assert.deepEqual(tag.destinations.map((d) => d.label), ['Export', 'France']);
  const checked = { ...cosmeto, match_description: true };
  assert.equal(situationForwarding({ category: 'cosmetovigilance', destinations: [checked], switchedOn: true }).route, 'choose');
});

test('no tag when forwarding is off, the destination is off, or its kinds exclude the situation', () => {
  assert.equal(situationForwarding({ category: 'cosmetovigilance', destinations: [cosmeto], switchedOn: false }), null);
  assert.equal(situationForwarding({ category: 'cosmetovigilance', destinations: [{ ...cosmeto, active_since: null }], switchedOn: true }), null);
  const kinds = { ...cosmeto, request_kinds: ['complaint'] };
  assert.equal(situationForwarding({ category: 'cosmetovigilance', requestKind: 'question', destinations: [kinds], switchedOn: true }), null);
  assert.equal(situationForwarding({ category: 'orders', destinations: [cosmeto], switchedOn: true }), null);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NON_DEMAND_LABELS,
  OWN_SIDE_LABELS,
  SENDER_ROLES,
  buildSenderDirectory,
  emptySenderDirectory,
  senderRole,
  senderRoleName
} from './sender-directory.mjs';

const rows = [
  { pattern_type: 'domain', pattern: 'lap-groupe.com', label: 'internal', note: null },
  { pattern_type: 'domain', pattern: 'deret.fr', label: 'logistics', note: '3PL warehouse' },
  { pattern_type: 'domain', pattern: 'nocibe.fr', label: 'retailer', note: null },
  { pattern_type: 'email', pattern: 'patrick@dopweb.com', label: 'contractor', note: 'web agency' }
];

const directory = buildSenderDirectory(rows, { supportMailbox: 'contact@qiriness.com' });

test('an unlisted sender is nobody in particular — the ordinary consumer case', () => {
  assert.equal(directory.lookup('someone@gmail.com'), null);
  assert.equal(directory.isNonDemand('someone@gmail.com'), false);
});

test('matches a domain, and carries the note through', () => {
  assert.deepEqual(directory.lookup('taha@deret.fr'), {
    label: 'logistics',
    note: '3PL warehouse',
    pattern: 'deret.fr',
    matched: 'domain'
  });
});

test('subdomains belong to their parent domain', () => {
  assert.equal(directory.lookup('noreply@mail.deret.fr')?.label, 'logistics');
  // But a domain that merely ENDS with the same letters does not.
  assert.equal(directory.lookup('someone@notderet.fr'), null);
});

test('an exact address wins over the domain it belongs to', () => {
  const mixed = buildSenderDirectory([
    { pattern_type: 'domain', pattern: 'dopweb.com', label: 'partner', note: null },
    { pattern_type: 'email', pattern: 'patrick@dopweb.com', label: 'contractor', note: null }
  ]);
  assert.equal(mixed.lookup('patrick@dopweb.com')?.label, 'contractor');
  assert.equal(mixed.lookup('someone-else@dopweb.com')?.label, 'partner');
});

test('the support mailbox domain is internal without needing a row', () => {
  const entry = directory.lookup('dounia@qiriness.com');
  assert.equal(entry?.label, 'internal');
  assert.equal(directory.isNonDemand('dounia@qiriness.com'), true);
});

test('an explicit row for our own domain overrides the implied one', () => {
  const overridden = buildSenderDirectory(
    [{ pattern_type: 'domain', pattern: 'qiriness.com', label: 'contractor', note: 'outsourced desk' }],
    { supportMailbox: 'contact@qiriness.com' }
  );
  assert.equal(overridden.lookup('someone@qiriness.com')?.label, 'contractor');
});

test('our own mail and operational counterparties are not customer demand', () => {
  assert.equal(directory.isNonDemand('ludovic@lap-groupe.com'), true); // internal
  assert.equal(directory.isNonDemand('patrick@dopweb.com'), true); // contractor
  assert.equal(directory.isNonDemand('ops@deret.fr'), true); // logistics
});

test('a retailer IS demand — B2B, but real requests that deserve answers', () => {
  assert.equal(directory.lookup('reorders@nocibe.fr')?.label, 'retailer');
  assert.equal(directory.isNonDemand('reorders@nocibe.fr'), false);
  for (const label of ['retailer', 'distributor', 'supplier', 'partner']) {
    assert.ok(!NON_DEMAND_LABELS.includes(label), `${label} must stay in the demand set`);
  }
});

test('an unusable sender is never matched rather than guessed at', () => {
  for (const value of [null, undefined, '', '   ', 'not-an-address']) {
    assert.equal(directory.lookup(value), null);
    assert.equal(directory.isNonDemand(value), false);
  }
});

test('addresses match case- and whitespace-insensitively', () => {
  assert.equal(directory.lookup('  TAHA@Deret.FR  ')?.label, 'logistics');
});

test('the empty directory knows nothing and blocks nothing', () => {
  assert.equal(emptySenderDirectory.size, 0);
  assert.equal(emptySenderDirectory.lookup('anyone@anywhere.com'), null);
  assert.equal(emptySenderDirectory.isNonDemand('anyone@anywhere.com'), false);
});

test('the 3PL counts as our own side, and a courier does not', () => {
  // Not arbitrary: the 3PL runs the warehouse, so their threads are the back
  // office working a customer's return — the same shape as a colleague's. A
  // courier is a third party we may need to write to as their customer.
  assert.ok(OWN_SIDE_LABELS.includes('logistics'));
  assert.ok(!OWN_SIDE_LABELS.includes('courier'));
});

test('a retailer is never our own side, whatever else it is', () => {
  // Nocibé's purchase orders are real demand; routing them off the Tickets
  // queue would hide a class of work.
  assert.ok(!OWN_SIDE_LABELS.includes('retailer'));
  assert.ok(!OWN_SIDE_LABELS.includes('distributor'));
});

test('own-side and non-demand answer different questions and must not be swapped', () => {
  // NON_DEMAND_LABELS is for the clustering report ("is this customer demand");
  // OWN_SIDE_LABELS is for routing and drafting ("would a customer-voice reply
  // to this person be absurd"). Reusing the first for the second is the exact
  // bug that routed 14 threads off the queue and hid customer work.
  assert.notDeepEqual(OWN_SIDE_LABELS, NON_DEMAND_LABELS);
  assert.ok(NON_DEMAND_LABELS.includes('courier'));
  assert.ok(!OWN_SIDE_LABELS.includes('courier'));
});

// --- who a message is from, as a reply-writing model must read it -----------

test('a role is resolved per MESSAGE, not per thread', () => {
  // `tickets.sender_label` describes the thread from the address that opened
  // it. The corpus carries 38 inbound messages from `lap-groupe.com` across 22
  // tickets and 14 from Deret across 10, most of them on threads a customer
  // opened — so the thread's label cannot speak for them.
  const directory = buildSenderDirectory([
    { pattern_type: 'domain', pattern: 'lap-groupe.com', label: 'internal', note: null },
    { pattern_type: 'domain', pattern: 'deret.fr', label: 'logistics', note: null },
    { pattern_type: 'domain', pattern: 'nocibe.fr', label: 'retailer', note: null }
  ]);

  assert.equal(senderRole({ direction: 'inbound', from_email: 'x@gmail.com' }, directory), 'customer');
  assert.equal(senderRole({ direction: 'inbound', from_email: 'x@lap-groupe.com' }, directory), 'internal');
  assert.equal(senderRole({ direction: 'inbound', from_email: 'x@deret.fr' }, directory), 'logistics');
  assert.equal(senderRole({ direction: 'inbound', from_email: 'x@nocibe.fr' }, directory), 'retailer');
});

test('our own side is read from the direction, whatever the address says', () => {
  const directory = buildSenderDirectory([]);
  assert.equal(senderRole({ direction: 'outbound', from_email: 'x@gmail.com' }, directory), 'qiriness');
  assert.equal(senderRoleName({ direction: 'outbound' }, directory), 'Qiriness');
});

test('an unclassified sender is a member of the public, which is the safe direction', () => {
  // A domain nobody has filed is read as demand rather than quietly discounted.
  assert.equal(senderRole({ direction: 'inbound', from_email: 'x@unknown.example' }, buildSenderDirectory([])), 'customer');
  assert.equal(senderRole({ direction: 'inbound', from_email: null }), 'customer');
  assert.equal(senderRoleName({ direction: 'inbound' }), 'client');
});

test('a label with no display name falls back to customer rather than rendering a key', () => {
  // `SENDER_ROLES` is the vocabulary a prompt may show. A label added to the
  // table without a name here must not leak « spam » or a raw key into a reply.
  const directory = buildSenderDirectory([
    { pattern_type: 'domain', pattern: 'weird.example', label: 'not_a_display_role', note: null }
  ]);
  assert.equal(senderRole({ direction: 'inbound', from_email: 'x@weird.example' }, directory), 'customer');
  assert.ok(Object.values(SENDER_ROLES).every((name) => typeof name === 'string' && name.length > 0));
});

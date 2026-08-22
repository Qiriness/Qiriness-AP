import assert from 'node:assert/strict';
import test from 'node:test';

import { hashIdentifier } from '../../../scripts/lib/compliance-audit.mjs';

import { requesterFor } from './requester-repair.mjs';

const COLLEAGUE = 'tlamzouki@lap-groupe.com';
const CUSTOMER = 'lemaireju@yahoo.fr';
const isOwnSide = (email) => /lap-groupe\.com$/i.test(String(email ?? ''));

const msg = (from, name, at) => ({ from_email: from, from_name: name, received_at: at });

test('a colleague standing in for a customer is replaced by the customer', () => {
  // THE DEFECT. The ticket wears a colleague's identity while a real customer is
  // writing on the thread, so nothing joins and the queue names the wrong person.
  const should = requesterFor({
    ticket: { requester_email_hash: hashIdentifier(COLLEAGUE) },
    messages: [
      msg(COLLEAGUE, 'Taha LAMZOUKI', '2026-07-01T09:00:00Z'),
      msg(CUSTOMER, 'Julie Lemaire', '2026-07-01T10:00:00Z')
    ],
    isOwnSide
  });

  assert.equal(should.from_email, CUSTOMER);
  assert.equal(should.from_name, 'Julie Lemaire');
});

test('an internal thread ABOUT a customer is left alone', () => {
  // NOT A DEFECT, and the most important thing this rule does not do. A
  // colleague opens a thread to chase a customer's order: `sender_label` says
  // who wrote, the requester says who it is about, and the hash is what joins
  // the ticket to that customer's orders. Seven such tickets would have lost an
  // order match to a naive reconcile.
  const should = requesterFor({
    ticket: { requester_email_hash: hashIdentifier(CUSTOMER) },
    messages: [
      msg(COLLEAGUE, 'Taha LAMZOUKI', '2026-07-01T09:00:00Z'),
      msg(CUSTOMER, 'Julie Lemaire', '2026-07-01T10:00:00Z')
    ],
    isOwnSide
  });

  assert.equal(should, null);
});

test('a purely internal thread has no customer to name', () => {
  const should = requesterFor({
    ticket: { requester_email_hash: hashIdentifier(COLLEAGUE) },
    messages: [
      msg(COLLEAGUE, 'Taha LAMZOUKI', '2026-07-01T09:00:00Z'),
      msg('dnouali@lap-groupe.com', 'Dounia NOUALI', '2026-07-01T10:00:00Z')
    ],
    isOwnSide
  });

  assert.equal(should, null);
});

test('the EARLIEST external sender wins, whatever order the rows arrive in', () => {
  // Graph's delta is not chronological, so the rows cannot be trusted to be.
  const should = requesterFor({
    ticket: { requester_email_hash: hashIdentifier(COLLEAGUE) },
    messages: [
      msg('later@example.com', 'Later Person', '2026-07-05T09:00:00Z'),
      msg(COLLEAGUE, 'Taha LAMZOUKI', '2026-07-01T09:00:00Z'),
      msg(CUSTOMER, 'Julie Lemaire', '2026-07-02T09:00:00Z')
    ],
    isOwnSide
  });

  assert.equal(should.from_email, CUSTOMER);
});

test('a requester who is already a customer is never moved', () => {
  // Either it is correct, or it is the customer an internal thread is about.
  // This cannot tell those apart, so it touches neither.
  const should = requesterFor({
    ticket: { requester_email_hash: hashIdentifier('someone-else@example.com') },
    messages: [msg(CUSTOMER, 'Julie Lemaire', '2026-07-01T09:00:00Z')],
    isOwnSide
  });

  assert.equal(should, null);
});

test('a ticket with no inbound messages is left alone', () => {
  assert.equal(
    requesterFor({ ticket: { requester_email_hash: 'x' }, messages: [], isOwnSide }),
    null
  );
});

test('the hash comparison is case-insensitive, like the hashing itself', () => {
  // hashIdentifier lowercases, so a stored hash made from `Taha@LAP-Groupe.com`
  // must still be recognised as ours.
  const should = requesterFor({
    ticket: { requester_email_hash: hashIdentifier('TLamzouki@LAP-Groupe.com') },
    messages: [
      msg('TLamzouki@LAP-Groupe.com', 'Taha LAMZOUKI', '2026-07-01T09:00:00Z'),
      msg(CUSTOMER, 'Julie Lemaire', '2026-07-01T10:00:00Z')
    ],
    isOwnSide
  });

  assert.equal(should.from_email, CUSTOMER);
});

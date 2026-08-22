import assert from 'node:assert/strict';
import test from 'node:test';

import { exemptKnownSenders } from './known-senders.mjs';

const directory = {
  lookup(email) {
    if (/@deret\.fr$/i.test(String(email ?? ''))) return { label: 'logistics', pattern: 'deret.fr' };
    if (/@nocibe\.fr$/i.test(String(email ?? ''))) return { label: 'retailer', pattern: 'nocibe.fr' };
    return null;
  }
};

const item = (from_email, subject = 'Subject') => ({ message: { from_email, subject } });

const blockingGate = { check: () => ({ spam: true, reason: 'blocklist domain rule' }) };
const blockingTriage = async () => ({ spam: true, reason: 'automatic notification' });

test('a directory sender is never blocked by the blocklist', () => {
  // The measured case: an explicit blocklist rule dropped patrick@dopweb.com,
  // an address the directory records as our web agency.
  const { gate } = exemptKnownSenders({ senderDirectory: directory, gate: blockingGate });
  const verdict = gate.check(item('lbailly@deret.fr'));

  assert.equal(verdict.spam, false);
  assert.equal(verdict.exemptedBy, 'logistics');
});

test('a directory sender never reaches the model at all', async () => {
  // Skipped rather than overruled: deciding after the answer would pay for a
  // judgement we were always going to discard.
  let called = false;
  const { triage } = exemptKnownSenders({
    senderDirectory: directory,
    triage: async () => {
      called = true;
      return { spam: true };
    }
  });

  const verdict = await triage(item('EARGENTO@nocibe.fr'));
  assert.equal(verdict.spam, false);
  assert.match(verdict.reason, /known sender \(retailer\)/);
  assert.equal(called, false, 'the classifier should not have been called');
});

test('the match is case-insensitive, as addresses are', () => {
  const { gate } = exemptKnownSenders({ senderDirectory: directory, gate: blockingGate });
  assert.equal(gate.check(item('LBailly@Deret.FR')).spam, false);
});

test('an unlisted sender is left to the gates exactly as before', async () => {
  // THE ONE DIRECTION THIS MOVES A DECISION. It can only ever keep mail; it
  // never blocks anything that would otherwise have been kept.
  const { gate, triage } = exemptKnownSenders({
    senderDirectory: directory,
    gate: blockingGate,
    triage: blockingTriage
  });

  assert.equal(gate.check(item('stranger@example.com')).spam, true);
  assert.equal((await triage(item('stranger@example.com'))).spam, true);
});

test('a message with no sender is left to the gates', () => {
  const { gate } = exemptKnownSenders({ senderDirectory: directory, gate: blockingGate });
  assert.equal(gate.check({ message: {} }).spam, true);
  assert.equal(gate.check({}).spam, true);
});

test('an absent triage stays absent rather than becoming a stub', async () => {
  // No OpenAI key means no second gate; wrapping must not invent one that
  // silently keeps every email.
  const { triage } = exemptKnownSenders({ senderDirectory: directory, gate: blockingGate });
  assert.equal(triage, undefined);
});

test('the rest of the gate object survives wrapping', () => {
  // buildSpamGate may grow other members; the wrapper replaces `check` only.
  const { gate } = exemptKnownSenders({
    senderDirectory: directory,
    gate: { ...blockingGate, describe: () => 'blocklist' }
  });
  assert.equal(gate.describe(), 'blocklist');
});

test('no directory at all is not an error', () => {
  // A deployment with an empty table still ingests mail.
  const { gate } = exemptKnownSenders({ gate: blockingGate });
  assert.equal(gate.check(item('lbailly@deret.fr')).spam, true);
});

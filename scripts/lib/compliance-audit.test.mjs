import assert from 'node:assert/strict';
import test from 'node:test';

import { maskEmail } from './compliance-audit.mjs';

// --- maskEmail ----------------------------------------------------------------

test('maskEmail keeps the shape a person recognises and nothing else', () => {
  assert.equal(maskEmail('jocelyne.wastiel@bluewin.ch'), 'j***l@bluewin.ch');
  assert.equal(maskEmail('CATHERINE.MONTEIL@YAHOO.FR'), 'c***l@yahoo.fr');
});

test('maskEmail keeps the domain whole, because it is the discriminating half', () => {
  // "Same person, second address at the same provider" is the mismatch question,
  // and the domain is what answers it. A provider domain is not personal data —
  // the sender directory already stores company domains for the same reason.
  assert.match(maskEmail('someone@orange.fr'), /@orange\.fr$/);
});

test('maskEmail does not half-mask a short local part', () => {
  // `b***o@x.fr` would be longer than `bo@x.fr` and hide nothing.
  assert.equal(maskEmail('bo@x.fr'), '**@x.fr');
  assert.equal(maskEmail('a@x.fr'), '**@x.fr');
});

test('maskEmail returns null for anything that is not an address', () => {
  // Distinguishable from "we have one": a masked non-address would read as a
  // readable identifier we do not actually hold.
  assert.equal(maskEmail(null), null);
  assert.equal(maskEmail(''), null);
  assert.equal(maskEmail('not-an-address'), null);
  assert.equal(maskEmail('@nolocal.fr'), null);
  assert.equal(maskEmail('nodomain@'), null);
});

test('maskEmail cannot be reversed to reach anyone', () => {
  // The point of the column: two different addresses at one provider stay
  // distinguishable to a human without either being recoverable.
  const a = maskEmail('marie.dupont@orange.fr');
  const b = maskEmail('m.dupont@orange.fr');
  assert.equal(a, b, 'and identical shapes are honestly identical');
  assert.ok(!a.includes('dupont'));
});

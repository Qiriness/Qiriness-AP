import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSpamGate, normalizeEmail, normalizeDomain } from './spam-gate.mjs';

function item(fromEmail, { removed = false } = {}) {
  if (removed) {
    return { removed: true, graphMessageId: 'm', conversationId: 'c' };
  }
  return { removed: false, message: { from_email: fromEmail } };
}

const rules = [
  { id: 'r-email', pattern_type: 'email', pattern: 'Spammer@Bad.com' },
  { id: 'r-domain', pattern_type: 'domain', pattern: 'junk.example' }
];

test('blocks an exact blocklisted sender, case-insensitively', () => {
  const gate = buildSpamGate(rules);
  const result = gate.check(item('spammer@bad.com'));
  assert.equal(result.spam, true);
  assert.equal(result.ruleId, 'r-email');
  assert.equal(result.matched, 'email');
});

test('blocks any sender from a blocklisted domain', () => {
  const gate = buildSpamGate(rules);
  const result = gate.check(item('anyone@JUNK.example'));
  assert.equal(result.spam, true);
  assert.equal(result.ruleId, 'r-domain');
  assert.equal(result.matched, 'domain');
});

test('a domain rule also blocks its subdomains (e.g. e.linkedin.com)', () => {
  const gate = buildSpamGate([{ id: 'r-li', pattern_type: 'domain', pattern: 'linkedin.com' }]);
  assert.equal(gate.check(item('notifications@e.linkedin.com')).spam, true);
  assert.equal(gate.check(item('jobs-noreply@linkedin.com')).spam, true);
  // Lookalike domains must NOT be caught by the suffix rule.
  assert.equal(gate.check(item('hi@notlinkedin.com')).spam, false);
  assert.equal(gate.check(item('hi@mylinkedin.com.evil.co')).spam, false);
});

test('lets a normal sender through', () => {
  const gate = buildSpamGate(rules);
  assert.deepEqual(gate.check(item('marie@example.com')), { spam: false });
});

test('never flags removed tombstones or empty senders as spam', () => {
  const gate = buildSpamGate(rules);
  assert.equal(gate.check(item(null, { removed: true })).spam, false);
  assert.equal(gate.check(item(null)).spam, false);
  assert.equal(gate.check(item('')).spam, false);
});

test('an empty blocklist blocks nothing', () => {
  const gate = buildSpamGate([]);
  assert.equal(gate.check(item('spammer@bad.com')).spam, false);
});

test('normalizers trim, lowercase, and strip a leading @ from domains', () => {
  assert.equal(normalizeEmail('  Foo@Bar.COM '), 'foo@bar.com');
  assert.equal(normalizeDomain('  @Bad.Example '), 'bad.example');
  assert.equal(normalizeEmail(''), null);
  assert.equal(normalizeDomain(null), null);
});

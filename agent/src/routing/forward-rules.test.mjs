import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildForwardNote,
  isReadyToForward,
  isTransientGraphError,
  MAX_ACK_ATTEMPTS,
  planAcknowledgement,
  shouldForwardMessage
} from './forward-rules.mjs';

const INTERNAL = ['example.com'];

test('a colleague writing in is never forwarded back to a colleague', () => {
  assert.equal(shouldForwardMessage({ fromEmail: 'colleague@example.com', internalDomains: INTERNAL }), false);
  assert.equal(shouldForwardMessage({ fromEmail: 'buyer@shop.fr', internalDomains: INTERNAL }), true);
  // With no internal domains configured nothing is treated as ours.
  assert.equal(shouldForwardMessage({ fromEmail: 'colleague@example.com' }), true);
});

test('a destination that waits for our reply waits until one exists', () => {
  const later = { timing: 'after_first_reply' };
  assert.equal(isReadyToForward({ destination: later, hasOutbound: false }), false);
  assert.equal(isReadyToForward({ destination: later, hasOutbound: true }), true);
  assert.equal(isReadyToForward({ destination: { timing: 'immediate' }, hasOutbound: false }), true);
});

const ACK_DEST = { timing: 'immediate', acknowledge: true };
const ON = { ack_enabled: true };

test('the acknowledgement is sent once, to a person, when switched on', () => {
  assert.deepEqual(planAcknowledgement({ settings: ON, destination: ACK_DEST, routing: {}, recipient: 'buyer@shop.fr' }), { action: 'send' });
  for (const ack_state of ['sent', 'requested', 'skipped']) {
    assert.equal(planAcknowledgement({ settings: ON, destination: ACK_DEST, routing: { ack_state }, recipient: 'buyer@shop.fr' }).action, 'none', ack_state);
  }
});

test('a failed acknowledgement is retried until the cap', () => {
  const plan = (ack_attempts) =>
    planAcknowledgement({ settings: ON, destination: ACK_DEST, routing: { ack_state: 'failed', ack_attempts }, recipient: 'buyer@shop.fr' }).action;
  assert.equal(plan(1), 'send');
  assert.equal(plan(MAX_ACK_ATTEMPTS), 'none');
});

test('switched off, a colleague, a machine or nobody: skipped for good', () => {
  const reason = (overrides) =>
    planAcknowledgement({ settings: ON, destination: ACK_DEST, routing: {}, recipient: 'buyer@shop.fr', internalDomains: INTERNAL, ...overrides }).reason;
  assert.equal(reason({ settings: { ack_enabled: false } }), 'acknowledgements_off');
  assert.equal(reason({ recipient: 'colleague@example.com' }), 'internal_sender');
  assert.equal(reason({ recipient: 'noreply@shop.fr' }), 'automated_sender');
  assert.equal(reason({ recipient: null }), 'no_recipient');
});

test('a destination that does not acknowledge, or waits for our reply, has nothing to decide', () => {
  assert.equal(planAcknowledgement({ settings: ON, destination: { timing: 'immediate', acknowledge: false }, recipient: 'a@b.fr' }).action, 'none');
  assert.equal(planAcknowledgement({ settings: ON, destination: { timing: 'after_first_reply', acknowledge: true }, recipient: 'a@b.fr' }).action, 'none');
});

// --- the covering note -------------------------------------------------------

test('the note is in French, short, and names what arrived', () => {
  const note = buildForwardNote({
    category: 'careers',
    subject: 'Candidature Spontanée - Marketing & Business Development'
  });

  assert.match(note, /^Bonjour,/);
  assert.match(note, /Pour information, nous avons reçu une candidature/);
  assert.match(note, /Candidature Spontanée/);
  assert.match(note, /dans la boîte contact/);
  assert.match(note, /Merci !$/);
  // Internal, so no customer-facing sign-off and no invented instructions.
  assert.doesNotMatch(note, /Cordialement|Best regards|Qiriness Support/);
  assert.ok(note.split('\n').length <= 6, 'stays short');
});

test('the note is French throughout — no English leaks from the old copy', () => {
  for (const category of ['careers', 'b2b', 'partner_collaboration', 'other']) {
    const note = buildForwardNote({ category, subject: 'Objet du message' });
    assert.doesNotMatch(note, /\b(Hi|FYI|we've received|contact inbox|Thanks)\b/i, category);
  }
});

test('French quotation marks around the subject', () => {
  const note = buildForwardNote({ category: 'careers', subject: 'Candidature' });
  assert.match(note, /« Candidature »/);
  assert.doesNotMatch(note, /"Candidature"/);
});

test('the closing never has to agree in gender with the category', () => {
  // "je vous la transmets" would be wrong for `un signalement` and right for
  // `une candidature`. Referring to `le message` sidesteps agreement entirely,
  // so no category can produce a grammatical error.
  for (const category of ['careers', 'cosmetovigilance', 'b2b', 'other']) {
    assert.match(buildForwardNote({ category }), /Je vous transmets le message ci-dessous\./, category);
  }
});

test('each forwardable category gets its own natural phrasing', () => {
  assert.match(buildForwardNote({ category: 'b2b' }), /une demande commerciale \(B2B\)/);
  assert.match(buildForwardNote({ category: 'partner_collaboration' }), /une demande de partenariat/);
});

test('a missing subject still produces a sensible sentence', () => {
  const note = buildForwardNote({ category: 'careers' });
  assert.match(note, /nous avons reçu une candidature dans la boîte contact/);
  assert.doesNotMatch(note, /«\s*»/);
});

test('an unknown category falls back rather than producing broken French', () => {
  assert.match(buildForwardNote({ category: 'not_a_category' }), /nous avons reçu un message/);
});

test('after our first reply the note says the sender has been answered', () => {
  assert.match(buildForwardNote({ category: 'cosmetovigilance', afterReply: true }), /Une première réponse a déjà été envoyée à l'expéditeur\./);
  assert.doesNotMatch(buildForwardNote({ category: 'careers' }), /première réponse/);
});

test('a very long subject is truncated so the note stays a note', () => {
  const note = buildForwardNote({ category: 'b2b', subject: 'x'.repeat(400) });
  assert.ok(note.length < 320, `note was ${note.length} chars`);
  assert.match(note, /…/);
});

test('subject whitespace and newlines are flattened', () => {
  const note = buildForwardNote({ category: 'careers', subject: 'Candidature\n\n  alternance   CM' });
  assert.match(note, /« Candidature alternance CM »/);
});

test('transient Graph errors are told apart from permanent ones', () => {
  for (const code of ['ErrorMailboxMoveInProgress', 'ErrorServerBusy', 'HTTP 429', 'ServiceUnavailable']) {
    assert.equal(isTransientGraphError(`Graph forward failed: ${code}`), true, code);
  }
  for (const code of ['ErrorAccessDenied', 'ErrorInvalidRecipients', 'ErrorItemNotFound', 'HTTP 400']) {
    assert.equal(isTransientGraphError(`Graph forward failed: ${code}`), false, code);
  }
  assert.equal(isTransientGraphError(null), false);
});

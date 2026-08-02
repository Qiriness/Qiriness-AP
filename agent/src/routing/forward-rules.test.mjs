import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildForwardNote,
  isTransientGraphError,
  resolveAddress,
  shouldForward
} from './forward-rules.mjs';

const BOOK = new Map([
  ['careers', 'hr@example.com'],
  ['b2b', 'sales@example.com'],
  ['partner_collaboration', 'marketing@example.com']
]);

test('contact-kind mail in a configured category is forwarded', () => {
  for (const category of ['careers', 'b2b', 'partner_collaboration']) {
    assert.equal(
      shouldForward({ ticket: { category, request_kind: 'contact' }, addressByCategory: BOOK }),
      true,
      category
    );
  }
});

test('real customer work is never forwarded, even in a configured category', () => {
  // The reason the rule is (kind AND address) rather than address alone: `b2b`
  // holds genuine reorder problems that need action, and diverting one to sales
  // as an FYI would drop it.
  for (const kind of ['question', 'problem', 'complaint']) {
    assert.equal(
      shouldForward({ ticket: { category: 'b2b', request_kind: kind }, addressByCategory: BOOK }),
      false,
      kind
    );
  }
});

test('a category with no address is never forwarded', () => {
  // Absence is the off switch, so a fresh install forwards nothing.
  assert.equal(
    shouldForward({ ticket: { category: 'order', request_kind: 'contact' }, addressByCategory: BOOK }),
    false
  );
  assert.equal(
    shouldForward({ ticket: { category: 'careers', request_kind: 'contact' }, addressByCategory: new Map() }),
    false
  );
});

test('a blank or malformed address does not forward', () => {
  const book = new Map([['careers', '   '], ['b2b', 'not-an-address']]);
  assert.equal(shouldForward({ ticket: { category: 'careers', request_kind: 'contact' }, addressByCategory: book }), false);
  assert.equal(shouldForward({ ticket: { category: 'b2b', request_kind: 'contact' }, addressByCategory: book }), false);
});

test('a colleague writing in is never forwarded back to a colleague', () => {
  // Counted on the real corpus: 9 of 51 pending messages came from our own
  // domain — staff forwarding things into the inbox, subjects prefixed `TR:`.
  // `direction` only catches mail sent by the support mailbox itself, so a
  // colleague writing from their own address arrives as `inbound`.
  assert.equal(
    shouldForward({
      ticket: { category: 'b2b', request_kind: 'contact' },
      fromEmail: 'colleague@lap-groupe.com',
      addressByCategory: BOOK,
      internalDomains: ['lap-groupe.com']
    }),
    false
  );
});

test('an outside sender on the same ticket still forwards', () => {
  assert.equal(
    shouldForward({
      ticket: { category: 'b2b', request_kind: 'contact' },
      fromEmail: 'buyer@nocibe.fr',
      addressByCategory: BOOK,
      internalDomains: ['lap-groupe.com']
    }),
    true
  );
});

test('with no internal domains configured nothing is treated as ours', () => {
  assert.equal(
    shouldForward({
      ticket: { category: 'b2b', request_kind: 'contact' },
      fromEmail: 'colleague@lap-groupe.com',
      addressByCategory: BOOK
    }),
    true
  );
});

test('a missing ticket does not throw', () => {
  assert.equal(shouldForward({ ticket: null, addressByCategory: BOOK }), false);
  assert.equal(shouldForward({ addressByCategory: BOOK }), false);
});

test('resolveAddress accepts a Map or a plain object, and trims', () => {
  assert.equal(resolveAddress('careers', BOOK), 'hr@example.com');
  assert.equal(resolveAddress('careers', { careers: ' hr@example.com ' }), 'hr@example.com');
  assert.equal(resolveAddress('nope', BOOK), null);
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

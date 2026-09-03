import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildEmbeddingInput,
  buildMessageEmbeddingInput,
  hashEmbeddingInput,
  isShopNotificationSubject,
  MESSAGE_HASH_SALT
} from './embedding-input.mjs';

test('composes title, heading, and text in a fixed order', () => {
  const input = buildEmbeddingInput({
    title: 'Livraison',
    category: 'delivery',
    section_heading: 'Delais',
    chunk_text: 'Nous livrons en 3 jours.'
  });
  // The category is deliberately absent — see below.
  assert.equal(input, 'Livraison\n\nDelais\n\nNous livrons en 3 jours.');
});

test('the category is not embedded: retrieval already filters on it', () => {
  // Embedding the category name into every chunk adds a near-constant to every
  // candidate inside a category-filtered set, and a constant contributes nothing
  // to ranking while diluting the real content. `title` carries the topical
  // anchoring instead.
  const base = { title: 'T', section_heading: 'H', chunk_text: 'Same body.' };
  const before = hashEmbeddingInput(buildEmbeddingInput({ ...base, category: 'old' }));
  const after = hashEmbeddingInput(buildEmbeddingInput({ ...base, category: 'new' }));
  assert.equal(before, after);
});

test('is deterministic and whitespace-stable in the prefix fields', () => {
  const a = buildEmbeddingInput({
    title: '  Livraison  ',
    category: 'delivery',
    section_heading: 'Delais\t',
    chunk_text: 'Nous livrons en 3 jours.'
  });
  const b = buildEmbeddingInput({
    title: 'Livraison',
    category: 'delivery',
    section_heading: 'Delais',
    chunk_text: 'Nous livrons en 3 jours.'
  });
  assert.equal(a, b);
  assert.equal(hashEmbeddingInput(a), hashEmbeddingInput(b));
});

test('preserves internal paragraph structure of the chunk body', () => {
  const input = buildEmbeddingInput({
    title: 'T',
    chunk_text: 'Para un.\n\nPara deux.'
  });
  assert.match(input, /Para un\.\n\nPara deux\./);
});

test('omits blank prefix fields instead of emitting empty separators', () => {
  const input = buildEmbeddingInput({ title: '', category: '', section_heading: '', chunk_text: 'Texte.' });
  assert.equal(input, 'Texte.');
});

test('a title rename changes the hash even when chunk text is identical', () => {
  // content_hash covers only { source, section_index, text }, so the title is
  // exactly the case embedded_input_hash exists to catch.
  const base = { section_heading: 'H', chunk_text: 'Same body.' };
  const before = hashEmbeddingInput(buildEmbeddingInput({ ...base, title: 'Old' }));
  const after = hashEmbeddingInput(buildEmbeddingInput({ ...base, title: 'New' }));
  assert.notEqual(before, after);
});

test('a heading rename changes the hash', () => {
  const base = { title: 'T', category: 'c', chunk_text: 'Same body.' };
  const before = hashEmbeddingInput(buildEmbeddingInput({ ...base, section_heading: 'A' }));
  const after = hashEmbeddingInput(buildEmbeddingInput({ ...base, section_heading: 'B' }));
  assert.notEqual(before, after);
});

// --- email messages ----------------------------------------------------------

test('a message composes as subject then quote-stripped body', () => {
  const input = buildMessageEmbeddingInput({
    subject: 'Colis bloqué',
    body_text: "Mon colis n'a pas bougé depuis 5 jours.\n\nLe 12 juillet, Support a écrit :\n> Bonjour, il est en transit."
  });
  assert.equal(input, "Colis bloqué\n\nMon colis n'a pas bougé depuis 5 jours.");
});

test('the subject is kept because support subject lines carry signal', () => {
  const input = buildMessageEmbeddingInput({
    subject: 'remboursement commande #5229',
    body_text: 'Bonjour, merci de traiter.'
  });
  assert.match(input, /remboursement commande #5229/);
});

test('sender identity never reaches the embedding input', () => {
  // It is personal data, and it says nothing about what the email is about.
  const input = buildMessageEmbeddingInput({
    subject: 'Question',
    body_text: 'Bonjour, une question.',
    from_email: 'marie@example.fr',
    from_name: 'Marie Dupont'
  });
  assert.doesNotMatch(input, /marie@example\.fr|Marie Dupont/);
});

test('a message with no subject still composes', () => {
  assert.equal(buildMessageEmbeddingInput({ body_text: 'Juste le corps.' }), 'Juste le corps.');
});

test('an empty message composes to an empty string, not whitespace', () => {
  // embedChunks skips these rather than spending a call on nothing.
  assert.equal(buildMessageEmbeddingInput({ subject: '  ', body_text: '\n\n' }), '');
  assert.equal(buildMessageEmbeddingInput({}), '');
});

test('message hashes are salted with the stripper version', () => {
  // Changing how quoted history is removed must invalidate stored vectors, but
  // the version must never appear in the text the model reads.
  const input = buildMessageEmbeddingInput({ subject: 'S', body_text: 'B' });
  assert.doesNotMatch(input, /quoted-reply/);
  assert.notEqual(
    hashEmbeddingInput(input, { salt: MESSAGE_HASH_SALT }),
    hashEmbeddingInput(input)
  );
  assert.notEqual(
    hashEmbeddingInput(input, { salt: 'quoted-reply/1' }),
    hashEmbeddingInput(input, { salt: 'quoted-reply/2' })
  );
});

test('the same message always hashes the same', () => {
  const message = { subject: ' Colis ', body_text: 'Texte.\n' };
  assert.equal(
    hashEmbeddingInput(buildMessageEmbeddingInput(message), { salt: MESSAGE_HASH_SALT }),
    hashEmbeddingInput(buildMessageEmbeddingInput(message), { salt: MESSAGE_HASH_SALT })
  );
});

test('our own notification subjects are dropped from the embedded text', () => {
  // 225 of 574 inbound messages carry one of these. « Nouveau message de client
  // le 7 août 2026 » is a near-constant with a date in it — hundreds of
  // unrelated tickets sharing a phrase they have no business sharing — and
  // « Votre commande est confirmée » is worse than empty on a complaint that the
  // order never arrived.
  const ours = buildMessageEmbeddingInput({
    subject: 'Nouveau message de client le 7 août 2026 à 09:51',
    body_text: "Je n'ai toujours pas reçu ma commande."
  });
  assert.equal(ours, "Je n'ai toujours pas reçu ma commande.");

  // A subject the CUSTOMER wrote still carries real signal and is kept.
  const theirs = buildMessageEmbeddingInput({
    subject: 'Commande 6059',
    body_text: "Je n'ai toujours pas reçu ma commande."
  });
  assert.equal(theirs, "Commande 6059\n\nJe n'ai toujours pas reçu ma commande.");
});

test('the reply markers a subject collects down a thread do not hide it', () => {
  // « RE: RE: Nouveau message de client » is the same worthless heading three
  // replies later, and that shape is common in the corpus.
  assert.equal(isShopNotificationSubject('RE:  RE: Nouveau message de client le 3 mai'), true);
  assert.equal(isShopNotificationSubject('Re: Votre commande est confirmée'), true);
  assert.equal(isShopNotificationSubject('TR: Votre commande #6216 est en route'), true);

  // Anchored at the start, so a real subject that merely contains the words is
  // not swallowed — and the word boundary keeps « clientele » out.
  assert.equal(isShopNotificationSubject('Commande 6059'), false);
  assert.equal(isShopNotificationSubject('Nouveau message de clientele important'), false);
  assert.equal(isShopNotificationSubject(null), false);
});

test('the hash salt covers what is composed, not only how quotes are stripped', () => {
  // Dropping the subject changed the text for 225 messages and left 349
  // byte-identical. Those must not be re-embedded, so the version cannot live in
  // the composed string — it lives in the salt, which every message hashes with.
  assert.match(MESSAGE_HASH_SALT, /quoted-reply\//);
  assert.match(MESSAGE_HASH_SALT, /message-input\//);
});

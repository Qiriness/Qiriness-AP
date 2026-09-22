import assert from 'node:assert/strict';
import test from 'node:test';

import { parseEmailForDisplay } from './email-display.mjs';

test('keeps new content and separates quoted history without changing raw', () => {
  const raw = [
    'Bonjour,',
    '',
    "Je n'ai toujours pas de nouvelles.",
    '',
    'Bien cordialement,',
    'Joachim',
    '',
    'Le 16 juillet 2026 à 10:00, Qiriness a écrit :',
    'Votre colis est parti.',
  ].join('\n');
  const parsed = parseEmailForDisplay(raw);
  assert.equal(parsed.raw, raw);
  assert.equal(parsed.bodyClean, "Bonjour,\n\nJe n'ai toujours pas de nouvelles.");
  assert.equal(parsed.signature, 'Bien cordialement,\nJoachim');
  assert.match(parsed.quotedBody, /Votre colis est parti/);
  assert.equal(parsed.quotedMessageCount, 1);
  assert.equal(parsed.isForward, false);
});

test('shows a forward intro separately from forwarded content', () => {
  const raw = ['Merci Taha', '', '-----Message transféré-----', 'De : client@example.com', 'Pouvez-vous vérifier ?'].join('\n');
  const parsed = parseEmailForDisplay(raw);
  assert.equal(parsed.bodyClean, 'Merci Taha');
  assert.equal(parsed.quotedBody, null);
  assert.match(parsed.forwardedContent, /Pouvez-vous vérifier/);
  assert.equal(parsed.isForward, true);
});

test('does not duplicate a bare forward in the default body', () => {
  const raw = ['-----Forwarded message-----', 'From: customer@example.com', 'Where is my parcel?'].join('\n');
  const parsed = parseEmailForDisplay(raw);
  assert.equal(parsed.bodyClean, null);
  assert.equal(parsed.forwardedContent, raw);
  assert.equal(parsed.isForward, true);
});

test('leaves ordinary prose untouched', () => {
  const raw = 'Bonjour,\n\nPouvez-vous confirmer le nouvel envoi ?';
  const parsed = parseEmailForDisplay(raw);
  assert.equal(parsed.bodyClean, raw);
  assert.equal(parsed.quotedBody, null);
  assert.equal(parsed.signature, null);
});

// Each header below is the exact shape one real ticket used when its whole
// history was repeated in the conversation view.
for (const [client, header] of [
  ['Yahoo FR forward', '----- Message transmis -----\n\nDe : Catherine <c@example.fr>'],
  ['Apple Mail FR forward', 'Début du message réexpédié :\n\nDe: contact <contact@qiriness.com>'],
  ['Orange reply header', 'envoyé : 26 août 2026 à 10:40\nde : contact <contact@qiriness.com>'],
  ['Gmail ES reply', 'El jue, 16 jul 2026, 16:01, contact < contact@qiriness.com > escribió:'],
  ['Gmail ES numeric date', 'El 07/08/2026 10:32 Blanca <b@example.es> escribió:'],
  ['Gmail IT reply', 'Il mer 2 set 2026, 10:35 Jacopo < j@example.it > ha scritto:'],
]) {
  test(`hides earlier history behind a ${client} header`, () => {
    const raw = `Toujours rien reçu.\n\n${header}\n\nBonjour, votre colis est parti.`;
    const parsed = parseEmailForDisplay(raw);
    assert.equal(parsed.bodyClean, 'Toujours rien reçu.');
    assert.match(parsed.quotedBody ?? parsed.forwardedContent, /votre colis est parti/);
  });
}

test('prose starting with "Il" is not mistaken for an Italian reply header', () => {
  const raw = 'Il manque un produit dans mon colis.\n\nMerci de vérifier.';
  assert.equal(parseEmailForDisplay(raw).bodyClean, raw);
});

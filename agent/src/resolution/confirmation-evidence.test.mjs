import assert from 'node:assert/strict';
import test from 'node:test';

import { hashIdentifier } from '../../../scripts/lib/compliance-audit.mjs';

import { countConfirmationMarkers, messageEmailHashes } from './confirmation-evidence.mjs';

test('an address anywhere in the text is found, wherever it sits', () => {
  const hashes = messageEmailHashes('Bonjour, mon compte est marie@example.fr, merci');
  assert.deepEqual(hashes, [hashIdentifier('marie@example.fr')]);
});

test('the hash is directly comparable to orders.customer_email_hash', () => {
  // Both sides are hashIdentifier, so a match is a match without either holding
  // the raw address — the whole reason only hashes leave the module.
  const hashes = messageEmailHashes('Client\nMarie Martin\nMARIE@Example.FR\n');
  assert.ok(hashes.includes(hashIdentifier('marie@example.fr')), 'case and spacing normalised');
});

test('sentence punctuation does not change the hash', () => {
  // `écrit à jean@x.fr.` would otherwise hash "jean@x.fr." and match nothing.
  for (const text of ['écrit à jean@x.fr.', 'de jean@x.fr,', '<jean@x.fr>', '(jean@x.fr)']) {
    assert.ok(messageEmailHashes(text).includes(hashIdentifier('jean@x.fr')), text);
  }
});

test('a mailto: link resolves to the same address', () => {
  assert.deepEqual(messageEmailHashes('mailto:jean@x.fr'), [hashIdentifier('jean@x.fr')]);
});

test('the same address twice yields one hash', () => {
  const hashes = messageEmailHashes('jean@x.fr wrote, reply to Jean@X.fr');
  assert.equal(hashes.length, 1);
});

test('text with no addresses yields nothing, and null input is safe', () => {
  assert.deepEqual(messageEmailHashes('ma commande #4854 est en retard'), []);
  assert.deepEqual(messageEmailHashes(null), []);
  assert.deepEqual(messageEmailHashes(undefined), []);
  assert.deepEqual(messageEmailHashes(''), []);
});

test('a pathological message cannot produce unbounded hashes', () => {
  const text = Array.from({ length: 400 }, (_, i) => `user${i}@example.com`).join(' ');
  assert.equal(messageEmailHashes(text).length, 50);
});

test('the real confirmation shape yields the client address', () => {
  // The layout as it actually arrives: flattened by htmlToText, values on their
  // own lines, quoted underneath a forward header.
  const text = [
    'Re: ma commande',
    '',
    'El 26/07/2026 16:27 Qiriness <contact@qiriness.com> escribió:',
    '',
    'Confirmation de votre commande',
    'N° de commande #6653',
    '26/07/2026',
    '',
    'Client',
    'BLANCA Blanca',
    'Espagne',
    'blanca@example.es',
    '',
    'Description de votre commande',
    'Sous-total',
    '37,80€'
  ].join('\n');

  const hashes = messageEmailHashes(text);
  assert.ok(hashes.includes(hashIdentifier('blanca@example.es')));
  assert.ok(hashes.includes(hashIdentifier('contact@qiriness.com')), 'store addresses are hashed too');
});

test('markers are counted, but a reworded template still yields the address', () => {
  // THE POINT OF THE DESIGN. Every label below is different from Shopify's
  // default wording; the marker count collapses and the evidence does not.
  const reworded = [
    'Votre achat chez Qiriness',
    'Référence : #6653',
    'Acheteur : blanca@example.es'
  ].join('\n');

  assert.equal(countConfirmationMarkers(reworded), 0, 'labels no longer recognisable');
  assert.ok(
    messageEmailHashes(reworded).includes(hashIdentifier('blanca@example.es')),
    'the address is still found, because nothing keys on the labels'
  );
});

test('markers are recognised across the languages the mailbox sees', () => {
  assert.ok(countConfirmationMarkers('N° de commande #6653\nSous-total\nInfos de paiement') >= 3);
  assert.ok(countConfirmationMarkers('Order number #6653\nSubtotal\nShipping address') >= 3);
  assert.ok(countConfirmationMarkers('Número de pedido #6653\nSubtotal\nDirección de envío') >= 3);
});

test('ordinary customer mail carries no markers', () => {
  assert.equal(countConfirmationMarkers('Bonjour, où est mon colis ? Merci, Marie'), 0);
});

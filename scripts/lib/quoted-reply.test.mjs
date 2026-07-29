import assert from 'node:assert/strict';
import test from 'node:test';

import { stripQuotedReply, findQuoteBoundary, hasQuotedReply, STRIPPER_VERSION } from './quoted-reply.mjs';

test('strips a Gmail-style French quote', () => {
  const body = `Bonjour,

Merci pour votre retour, et du coup pour le remboursement ?

Cordialement,
Marie

Le 12 juillet 2026 à 14:32, Support <contact@qiriness.com> a écrit :
> Bonjour Marie, votre colis a été expédié hier.`;

  const out = stripQuotedReply(body);
  assert.match(out, /du coup pour le remboursement/);
  assert.doesNotMatch(out, /a écrit/);
  assert.doesNotMatch(out, /votre colis a été expédié/);
  assert.ok(out.trimEnd().endsWith('Marie'));
});

test('strips the English Gmail form', () => {
  const out = stripQuotedReply(
    'Any update on this?\n\nOn Mon, Jul 12, 2026 at 2:32 PM Support <c@q.com> wrote:\n> We are looking into it.'
  );
  assert.equal(out, 'Any update on this?');
});

test("strips Outlook's -----Message d'origine----- block", () => {
  const out = stripQuotedReply(
    "Merci de votre réponse.\n\n-----Message d'origine-----\nDe : Support\nEnvoyé : lundi 12 juillet\nObjet : RE: commande\n\nBonjour..."
  );
  assert.equal(out, 'Merci de votre réponse.');
});

test('strips an Outlook De:/Envoyé: header block with no separator line', () => {
  const out = stripQuotedReply(
    'Bonjour, je relance.\n\nDe : Service Client\nEnvoyé : mardi 13 juillet 2026 09:14\nÀ : Marie\nObjet : RE: colis\n\nBonjour Marie...'
  );
  assert.equal(out, 'Bonjour, je relance.');
});

test('a bare "De :" in prose is not a boundary', () => {
  // The Envoyé/Date line is required, so ordinary sentences survive.
  const body = 'Bonjour, la facture vient De : notre partenaire logistique, est-ce normal ?';
  assert.equal(stripQuotedReply(body), body);
});

test("strips Outlook's underscore rule", () => {
  const out = stripQuotedReply(
    'Voici les informations demandées.\n\n________________________________\nDe : Support\nObjet : RE'
  );
  assert.equal(out, 'Voici les informations demandées.');
});

test('strips a plain > quote block', () => {
  const out = stripQuotedReply('Oui c’est bien cela.\n\n> Confirmez-vous l’adresse ?');
  assert.equal(out, 'Oui c’est bien cela.');
});

test('handles the non-breaking space French mail actually sends', () => {
  // "De :" with U+00A0 before the colon is what Outlook FR emits.
  const out = stripQuotedReply(
    'Je vous remercie.\n\nDe : Support\nEnvoyé : lundi\nObjet : RE'
  );
  assert.equal(out, 'Je vous remercie.');
});

test('cuts at the EARLIEST marker when several are present', () => {
  const out = stripQuotedReply(
    'Ma réponse.\n\nLe 12 juillet, Support a écrit :\n\n-----Message d’origine-----\nDe : X\nEnvoyé : Y'
  );
  assert.equal(out, 'Ma réponse.');
});

test('a message with no quote is returned untouched', () => {
  const body = 'Bonjour,\n\nOù est ma commande #1042 ?\n\nMerci';
  assert.equal(stripQuotedReply(body), body);
  assert.equal(hasQuotedReply(body), false);
  assert.equal(findQuoteBoundary(body), null);
});

test('a wholly quoted message keeps its original body', () => {
  // A bare forward would otherwise strip to nothing, and a blank body is worse
  // for both embedding and classification than a noisy one.
  const body = '> Bonjour, je voudrais un remboursement.\n> Merci.';
  assert.equal(stripQuotedReply(body), body);
  // ... the marker is still detected, so callers can log it.
  assert.equal(hasQuotedReply(body), true);
});

test('a marker on the very first line keeps the original', () => {
  const body = "-----Message d'origine-----\nDe : Marie\nObjet : commande";
  assert.equal(stripQuotedReply(body), body);
});

test('junk input does not throw', () => {
  assert.equal(stripQuotedReply(null), null);
  assert.equal(stripQuotedReply(undefined), null);
  assert.equal(stripQuotedReply(''), '');
  assert.equal(findQuoteBoundary(42), null);
});

test('the version is exported so the embedding hash can depend on it', () => {
  // Changing the stripper must invalidate stored vectors; mixing this into the
  // hash is what makes the reconciler re-embed.
  assert.match(STRIPPER_VERSION, /^quoted-reply\/\d+$/);
});

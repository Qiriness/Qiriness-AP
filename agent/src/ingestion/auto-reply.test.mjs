import assert from 'node:assert/strict';
import test from 'node:test';

import { autoReplySignal } from './auto-reply.mjs';

const h = (name, value) => [{ name, value }];

test('the RFC 3834 header marks an automatic reply', () => {
  assert.equal(autoReplySignal({ headers: h('Auto-Submitted', 'auto-replied') }), 'header:auto-submitted');
  assert.equal(autoReplySignal({ headers: h('auto-submitted', 'Auto-Replied; vacation') }), 'header:auto-submitted');
});

test('a notification is machine mail but not a reply: it opens or feeds a case', () => {
  assert.equal(autoReplySignal({ headers: h('Auto-Submitted', 'auto-generated'), subject: 'Nouveau message de client' }), null);
  assert.equal(autoReplySignal({ headers: h('Auto-Submitted', 'no') }), null);
  assert.equal(autoReplySignal({ headers: h('Precedence', 'bulk') }), null);
});

test('the vendor headers, iCloud included: it sends no Auto-Submitted at all', () => {
  // The message that found this (35e0afd9, 2026-10-05) carried only this one.
  assert.equal(autoReplySignal({ headers: h('X-Apple-Action', 'VACATION') }), 'header:x-apple-action');
  assert.equal(autoReplySignal({ headers: h('X-Autoreply', 'yes') }), 'header:x-autoreply');
  assert.equal(autoReplySignal({ headers: h('X-Autorespond', 'Out of office') }), 'header:x-autorespond');
  assert.equal(autoReplySignal({ headers: h('Precedence', 'auto_reply') }), 'header:precedence');
  assert.equal(autoReplySignal({ headers: h('X-Apple-Action', 'FORWARD') }), null);
});

test('the subject is the fallback, in the languages customers write in', () => {
  for (const subject of [
    'Auto reply: RE: Nouveau message de client le 1 octobre 2026 à 10:23',
    'Automatic reply: RE: Votre commande',
    'Réponse automatique : RE: Votre commande',
    'Absent(e) du bureau : RE: Votre commande',
    'Abwesenheitsnotiz: AW: Bestellung',
    'Respuesta automática: RE: Pedido'
  ]) {
    assert.equal(autoReplySignal({ subject }), 'subject', subject);
  }
});

test('a customer who mentions an automatic reply is still the customer', () => {
  assert.equal(autoReplySignal({ subject: "RE: j'ai reçu une réponse automatique mais pas de code" }), null);
  assert.equal(autoReplySignal({ subject: 'Nouveau message de client le 1 octobre 2026 à 10:23' }), null);
  assert.equal(autoReplySignal({}), null);
});

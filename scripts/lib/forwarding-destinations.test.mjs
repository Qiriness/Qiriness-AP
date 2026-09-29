import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ackLanguage,
  candidatesFor,
  DEFAULT_ACK_TEMPLATES,
  isAutomatedAddress,
  normaliseAckSettings,
  normaliseDestination,
  renderAcknowledgement,
  routingModeByCategory
} from './forwarding-destinations.mjs';

const base = { label: 'Accounting', forwardEmail: 'Accounts@Example.com ', categories: ['b2b'] };

test('a destination is normalised to the columns it is stored in', () => {
  const result = normaliseDestination({
    ...base,
    description: '  Invoices,   duplicates  ',
    requestKinds: ['problem', 'question', 'problem']
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.forward_email, 'accounts@example.com');
  assert.equal(result.value.description, 'Invoices, duplicates');
  // Deduplicated and in the vocabulary's order, whatever order was ticked.
  assert.deepEqual(result.value.request_kinds, ['question', 'problem']);
  assert.equal(result.value.timing, 'immediate');
  assert.equal(result.value.acknowledge, true);
});

test('an empty address is the off switch, not an error', () => {
  const result = normaliseDestination({ ...base, forwardEmail: '  ' });
  assert.equal(result.ok, true);
  assert.equal(result.value.forward_email, null);
});

test('a destination is refused without a name, a valid address or a category', () => {
  assert.equal(normaliseDestination({ ...base, label: ' ' }).ok, false);
  assert.equal(normaliseDestination({ ...base, forwardEmail: 'not-an-address' }).ok, false);
  assert.equal(normaliseDestination({ ...base, categories: [] }).ok, false);
  assert.equal(normaliseDestination({ ...base, categories: ['faq'] }).ok, false);
  assert.equal(normaliseDestination({ ...base, requestKinds: ['praise'] }).ok, false);
  assert.equal(normaliseDestination({ ...base, timing: 'tomorrow' }).ok, false);
});

test('a destination that waits for our first reply never acknowledges as well', () => {
  const result = normaliseDestination({ ...base, timing: 'after_first_reply', acknowledge: true });
  assert.equal(result.value.acknowledge, false);
});

test('clearing a template stores null, which restores the default', () => {
  const result = normaliseAckSettings({ ackEnabled: true, ackTemplateFr: '   ', ackTemplateEn: 'Hi {service}' });
  assert.deepEqual(result.value, { ack_enabled: true, ack_template_fr: null, ack_template_en: 'Hi {service}' });
  assert.equal(normaliseAckSettings({}).value.ack_enabled, false);
});

const row = (label, categories, extra = {}) => ({
  label,
  forward_email: `${label.toLowerCase()}@example.com`,
  categories,
  request_kinds: [],
  ...extra
});

test('routing is fixed with one active destination and a choice with several', () => {
  const modes = routingModeByCategory([
    row('Careers', ['careers']),
    row('Accounting', ['b2b']),
    row('Export', ['b2b']),
    row('Defects', ['product'], { forward_email: null })
  ]);
  assert.deepEqual(modes.careers, { mode: 'fixed', destinations: ['Careers'] });
  assert.deepEqual(modes.b2b, { mode: 'choice', destinations: ['Accounting', 'Export'] });
  // Switched off: described, but nothing leaves.
  assert.equal(modes.product.mode, 'stays');
  assert.equal(modes.delivery.mode, 'stays');
});

test('one destination that must match its description is still the agent\'s call', () => {
  const modes = routingModeByCategory([row('Defects', ['product'], { match_description: true, description: 'Defects' })]);
  assert.deepEqual(modes.product, { mode: 'choice', destinations: ['Defects'] });
});

test('matching the description needs a description to match', () => {
  assert.equal(normaliseDestination({ ...base, matchDescription: true }).ok, false);
  const result = normaliseDestination({ ...base, matchDescription: true, description: 'Defective products' });
  assert.equal(result.value.match_description, true);
  assert.equal(normaliseDestination(base).value.match_description, false);
});

test('candidates respect a destination limited to some request kinds', () => {
  const defects = row('Defects', ['product'], { request_kinds: ['problem', 'complaint'] });
  assert.deepEqual(candidatesFor([defects], { category: 'product', requestKind: 'problem' }), [defects]);
  assert.deepEqual(candidatesFor([defects], { category: 'product', requestKind: 'question' }), []);
  assert.deepEqual(candidatesFor([defects], { category: 'b2b', requestKind: 'problem' }), []);
});

test('machines are told apart from people by the local part', () => {
  for (const address of ['noreply@shop.com', 'no-reply@x.fr', 'ne-pas-repondre@banque.fr', 'mailer-daemon@x.com', 'notifications+po@x.com', 'bounce@x.com']) {
    assert.equal(isAutomatedAddress(address), true, address);
  }
  for (const address of ['buyer@nocibe.fr', 'david@tgertrading.co.uk', 'notaire@x.fr', 'automne@x.fr', null]) {
    assert.equal(isAutomatedAddress(address), false, String(address));
  }
});

test('French stays French, and every other language is answered in English', () => {
  assert.equal(ackLanguage('fr'), 'fr');
  assert.equal(ackLanguage(null), 'fr');
  assert.equal(ackLanguage('en'), 'en');
  assert.equal(ackLanguage('it'), 'en');
});

test('the acknowledgement names the service and carries its extra paragraph', () => {
  const text = renderAcknowledgement({
    destination: {
      public_name_fr: 'au service comptabilité',
      ack_note_fr: 'Pour toute demande future, écrivez à compta@example.com.'
    },
    shopName: 'Acme',
    language: 'fr'
  });
  assert.equal(
    text,
    'Bonjour,\n\n' +
      'Merci pour votre message. Nous l\'avons transmis au service comptabilité, qui reviendra vers vous directement.\n\n' +
      'Pour toute demande future, écrivez à compta@example.com.\n\n' +
      'Bien cordialement,\nLe service client Acme'
  );
});

test('without a name or a note it reads generically, with no gap where the note was', () => {
  const text = renderAcknowledgement({ destination: {}, shopName: 'Acme', language: 'en' });
  assert.equal(
    text,
    'Hello,\n\nThank you for your message. We have passed it on to the relevant team, who will get back to you directly.\n\n' +
      'Kind regards,\nAcme Customer Service'
  );
  assert.doesNotMatch(text, /\n{3,}/);
  // The French name carries its own preposition, so no « à le » can appear.
  const fr = renderAcknowledgement({ destination: {}, shopName: 'Acme', language: 'fr' });
  assert.match(fr, /Nous l'avons transmis au service concerné, qui/);
});

test('a shop template replaces the default, and a blank one falls back to it', () => {
  const custom = renderAcknowledgement({
    destination: { public_name_en: 'Accounts' },
    settings: { ack_template_en: 'Sent to {service}.' },
    language: 'en'
  });
  assert.equal(custom, 'Sent to Accounts.');
  const fallback = renderAcknowledgement({ settings: { ack_template_fr: '' }, shopName: 'Acme', language: 'fr' });
  assert.ok(fallback.startsWith(DEFAULT_ACK_TEMPLATES.fr.slice(0, 8)));
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseContactForm, isContactFormEmail } from './contact-form.mjs';

// The real shape, copied from a live notification (customer details invented).
const REAL = `Vous avez reçu un nouveau message du formulaire de contact de votre boutique en ligne.

Indicatif de pays:
FR

Name:
Dominique RAVAUX

E-mail:
doravaux@orange.fr

Phone:

Corps:
Bonjour,
Je voudrais savoir pourquoi je n ai pas reçu de code pour les -20%.
Et puis-je l'utiliser sur les soldes?

Bonne journée

Dominique RAVAUX`;

test('pulls the customer out of a real notification', () => {
  const form = parseContactForm(REAL);
  assert.equal(form.name, 'Dominique RAVAUX');
  assert.equal(form.email, 'doravaux@orange.fr');
  assert.equal(form.countryCode, 'FR');
  assert.equal(form.phone, null); // blank on the form, and blank is not "the next label"
});

test('the body is the customer text only, wrapper and labels stripped', () => {
  const { body } = parseContactForm(REAL);
  assert.ok(body.startsWith('Bonjour,'));
  assert.ok(body.includes("Et puis-je l'utiliser sur les soldes?"));
  // Multi-paragraph: a blank line must not end the message.
  assert.ok(body.includes('Bonne journée'));
  assert.ok(body.trimEnd().endsWith('Dominique RAVAUX'));
  // None of the scaffolding survives into what the model reads.
  assert.doesNotMatch(body, /formulaire de contact/i);
  assert.doesNotMatch(body, /^E-mail:/im);
  assert.doesNotMatch(body, /Indicatif de pays/i);
});

test('a blank field does not swallow the next label', () => {
  // `Phone:` followed by `Corps:` must leave the phone null rather than
  // capturing the literal string "Corps:".
  const form = parseContactForm(REAL);
  assert.equal(form.phone, null);
  assert.ok(form.body && !form.body.startsWith('Corps'));
});

test('accepts a value on the same line as its label', () => {
  const form = parseContactForm(`Nouveau message du formulaire de contact.

Name: Alexandra Bruns
E-mail: bruens-chen@web.de
Indicatif de pays: BE
Corps: Hello, can I order from Germany?`);
  assert.equal(form.name, 'Alexandra Bruns');
  assert.equal(form.email, 'bruens-chen@web.de');
  assert.equal(form.countryCode, 'BE');
  assert.equal(form.body, 'Hello, can I order from Germany?');
});

test('country code never implies language', () => {
  // A real case: Belgian country code, a .de address, and English prose. The
  // parser reports the country and stops — language stays an LLM read of the text.
  const form = parseContactForm(`formulaire de contact

Indicatif de pays:
BE

Name:
Alexandra Bruns

E-mail:
bruens-chen@web.de

Corps:
Hello, maybe I made a mistake, but I cannot choose Germany at checkout.`);
  assert.equal(form.countryCode, 'BE');
  assert.equal(Object.hasOwn(form, 'language'), false);
});

test('an ordinary customer email is not a contact form', () => {
  assert.equal(parseContactForm('Bonjour, où est ma commande #1042 ?'), null);
  assert.equal(isContactFormEmail('Bonjour, où est ma commande ?'), false);
});

test('a wrapper with no recoverable identity falls back rather than half-parsing', () => {
  // Better to keep the envelope than to write a customer with no name and no
  // address; the caller treats null as "not a contact form".
  assert.equal(parseContactForm('Vous avez reçu un nouveau message du formulaire de contact.'), null);
  // ... though it is still recognisably one, which the caller may want to know.
  assert.equal(isContactFormEmail('Vous avez reçu un nouveau message du formulaire de contact.'), true);
});

test('handles an English template and decorated addresses', () => {
  const form = parseContactForm(`You have received a new message from your online store's contact form.

Name: Jane Doe
Email: Jane Doe <JANE.DOE@Example.COM>
Body: Hi, where is my order?`);
  assert.equal(form.name, 'Jane Doe');
  assert.equal(form.email, 'jane.doe@example.com'); // unwrapped and lower-cased
  assert.equal(form.body, 'Hi, where is my order?');
});

test('the planned dropdown fields parse the day the form ships', () => {
  // Not on the Qiriness form yet. Listing the labels now means no code change
  // and no re-ingest when they are added.
  const form = parseContactForm(`formulaire de contact

Name:
Marie Dupont

E-mail:
marie@example.fr

Catégorie:
Livraison

Numéro de commande:
#1042

Corps:
Mon colis n'est pas arrivé.`);
  assert.equal(form.declaredCategory, 'Livraison');
  assert.equal(form.orderNumber, '#1042');
  assert.equal(form.body, "Mon colis n'est pas arrivé.");
});

test('fields absent from the form stay null, not undefined', () => {
  const form = parseContactForm(REAL);
  assert.equal(form.declaredCategory, null);
  assert.equal(form.orderNumber, null);
});

test('rejects junk input without throwing', () => {
  for (const input of [null, undefined, '', 42, {}]) {
    assert.equal(parseContactForm(input), null);
  }
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildStorefrontSystemPrompt } from './system-prompt.mjs';

const COMPANY = { name: 'Maison Test', description: 'une marque de soin de la peau' };

test('the brand comes from the shop data, never from the source', () => {
  const prompt = buildStorefrontSystemPrompt({ company: COMPANY });
  assert.match(prompt, /online beauty advisor of Maison Test \(une marque de soin de la peau\)\./);
  const source = readFileSync(new URL('./system-prompt.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /qiriness/i);
});

test('no company row still gives a usable prompt', () => {
  assert.match(buildStorefrontSystemPrompt(), /online beauty advisor of the brand\./);
});

test('it forbids exactly what Phase 2 cannot know', () => {
  const prompt = buildStorefrontSystemPrompt({ company: COMPANY });
  for (const rule of [/do not name any product, price, availability/, /current offers, promo codes/, /delivery times or costs/, /return conditions/]) {
    assert.match(prompt, rule);
  }
});

test('orders go to customer service, and nothing personal is asked for', () => {
  const prompt = buildStorefrontSystemPrompt({ company: COMPANY });
  assert.match(prompt, /any question about an order[^\n]*customer service handles it/);
  assert.match(prompt, /Never ask for an order number or an email address/);
  assert.match(prompt, /Ask for no personal data/);
});

test('health questions go to a professional', () => {
  assert.match(buildStorefrontSystemPrompt({ company: COMPANY }), /No medical claim[^\n]*dermatologist/);
});

test('the reply follows the latest customer message; French only as the fallback, with « vous »', () => {
  const prompt = buildStorefrontSystemPrompt({ company: COMPANY, context: { locale: 'fr' } });
  assert.match(prompt, /language of the customer's LATEST message/);
  assert.match(prompt, /gives no clue[^\n]*reply in French/);
  assert.match(prompt, /always use « vous »/);
  assert.match(prompt, /Storefront language: fr \(the language of the site, not necessarily the customer's\)/);
});

test('the page context is named, and a product handle is not passed off as knowledge', () => {
  const prompt = buildStorefrontSystemPrompt({ company: COMPANY, context: { pageType: 'product', productHandle: 'creme-eclat' } });
  assert.match(prompt, /The customer is viewing a product page\./);
  assert.match(prompt, /"creme-eclat" \(not in the catalogue you can see: do not describe it\)/);
  assert.match(buildStorefrontSystemPrompt({ context: { pageType: 'weird' } }), /The customer is viewing the site\./);
});

test('the reply shape is plain text inside the JSON object', () => {
  const prompt = buildStorefrontSystemPrompt({ company: COMPANY });
  assert.match(prompt, /Plain text only/);
  assert.match(prompt, /\{ "reply": "<your reply>", "products": \[/);
  assert.match(prompt, /`products` is always an empty list/);
});

test('with tools, products may be named only as a tool returned them', () => {
  const prompt = buildStorefrontSystemPrompt({ company: COMPANY, hasTools: true });
  assert.match(prompt, /THE MAISON TEST CATALOGUE/);
  assert.match(prompt, /ONLY as a tool returned it/);
  assert.match(prompt, /never suggest a product you have not seen in a tool result/);
  assert.match(prompt, /at most 3, best first/);
  assert.doesNotMatch(prompt, /do not name any product/);
  assert.match(prompt, /current offers, promo codes/, 'offers stay forbidden until their tool exists');
});

test('with tools, it is told to search early rather than interrogate', () => {
  assert.match(buildStorefrontSystemPrompt({ company: COMPANY, hasTools: true }), /SPEED MATTERS[^\n]*search straight away/);
});

test('the advisor never genders itself', () => {
  assert.match(buildStorefrontSystemPrompt({ company: COMPANY }), /Never use a gendered form for yourself/);
});

test('the page product is given as data at the very end, after everything stable', () => {
  const prompt = buildStorefrontSystemPrompt({
    company: COMPANY,
    hasTools: true,
    context: { pageType: 'product', productHandle: 'creme' },
    pageProduct: { handle: 'creme', name: 'Crème' }
  });
  assert.match(prompt, /The product on this page, from the catalogue/);
  assert.ok(prompt.trimEnd().endsWith('{"handle":"creme","name":"Crème"}'));
  assert.ok(prompt.lastIndexOf('\nVISIT CONTEXT\n') > prompt.indexOf('\nANSWER FORMAT\n'));
});

test('the resolution is data at the end; the rules about it are generic and name nothing', () => {
  const resolution = { status: 'ambiguous', products: [], candidates: [], clarification: { kind: 'choose_care_type', options: [{ label: 'Crème' }] }, unresolved_mentions: [], range: null };
  const prompt = buildStorefrontSystemPrompt({ company: COMPANY, hasTools: true, resolution });
  assert.match(prompt, /PRODUCTS THE CUSTOMER REFERS TO/);
  assert.match(prompt, /never choose one/);
  assert.ok(prompt.trimEnd().endsWith(JSON.stringify(resolution)));
  const rules = buildStorefrontSystemPrompt({ company: COMPANY, hasTools: true });
  assert.doesNotMatch(rules, /\n- resolution:\n/, 'no block when nothing was resolved');
  assert.equal(buildStorefrontSystemPrompt({ company: COMPANY, hasTools: true, resolution: { ...resolution, status: 'unresolved' } }).includes('- resolution:'), false);
});

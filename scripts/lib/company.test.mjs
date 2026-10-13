import assert from 'node:assert/strict';
import test from 'node:test';

import { companyFrom, serviceClientOf } from './company.mjs';
import { toParameterMap } from './parameters.mjs';

const parameters = toParameterMap([
  { parameter_key: 'company_description', value: ' une marque de soin de la peau ' },
  { parameter_key: 'logistics_provider_name', value: 'Entrepôt Exemple' }
]);

test('the name is the shop’s, the rest the merchant’s parameters', () => {
  assert.deepEqual(companyFrom({ shopName: ' Boutique Exemple ', parameters }), {
    name: 'Boutique Exemple',
    description: 'une marque de soin de la peau',
    logisticsProvider: 'Entrepôt Exemple',
    contactFormPath: '/pages/contact'
  });
  assert.deepEqual(companyFrom({}), { name: null, description: null, logisticsProvider: null, contactFormPath: '/pages/contact' });
});

test('the contact form is a path on the shop: a set path, else Shopify\'s own page; never another site', () => {
  const at = (value) => companyFrom({ parameters: new Map([['contact_form_path', value]]) }).contactFormPath;
  assert.equal(at('/pages/nous-contacter'), '/pages/nous-contacter');
  assert.equal(at('https://evil.example/form'), '/pages/contact');
  assert.equal(at('//evil.example'), '/pages/contact');
  assert.equal(at('javascript:alert(1)'), '/pages/contact');
});

test('the first line of an agent’s instructions names whatever is known', () => {
  assert.equal(
    serviceClientOf({ name: 'Boutique Exemple', description: 'une marque de soin de la peau' }),
    'service client de Boutique Exemple, une marque de soin de la peau'
  );
  assert.equal(serviceClientOf({ name: 'Boutique Exemple' }), 'service client de Boutique Exemple');
  assert.equal(serviceClientOf(null), 'service client d’une boutique en ligne');
});

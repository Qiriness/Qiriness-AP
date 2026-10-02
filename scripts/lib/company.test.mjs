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
    logisticsProvider: 'Entrepôt Exemple'
  });
  assert.deepEqual(companyFrom({}), { name: null, description: null, logisticsProvider: null });
});

test('the first line of an agent’s instructions names whatever is known', () => {
  assert.equal(
    serviceClientOf({ name: 'Boutique Exemple', description: 'une marque de soin de la peau' }),
    'service client de Boutique Exemple, une marque de soin de la peau'
  );
  assert.equal(serviceClientOf({ name: 'Boutique Exemple' }), 'service client de Boutique Exemple');
  assert.equal(serviceClientOf(null), 'service client d’une boutique en ligne');
});

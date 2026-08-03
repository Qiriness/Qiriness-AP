import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAccountState, buildCustomerContext, toPromptText } from './customer-context.mjs';
import { buildOrderContext } from '../resolution/order-context.mjs';

const CUSTOMER = {
  id: 'c1',
  display_name: 'Marie Martin',
  first_name: 'Marie',
  last_name: 'Martin',
  email: 'marie.martin@example.test',
  locale: 'fr',
  state: 'ENABLED',
  verified_email: true,
  valid_email_address: true,
  tags: ['vip'],
  email_marketing_state: 'SUBSCRIBED',
  email_marketing_consent_updated_at: '2026-01-04T10:00:00Z',
  on_email_marketing_list: true,
  default_address_city: 'Lyon',
  default_address_country: 'France',
  number_of_orders: 4,
  amount_spent: '312.50',
  amount_spent_currency: 'EUR',
  last_order_name: '#1009',
  last_order_at: '2026-06-02T09:00:00Z',
  last_order_total: '89.50',
  rfm_group: 'LOYAL'
};

test('buildCustomerContext shapes the row and coerces money to numbers', () => {
  const context = buildCustomerContext(CUSTOMER);

  assert.equal(context.name, 'Marie Martin');
  assert.equal(context.ordersCount, 4);
  assert.equal(context.amountSpent, 312.5);
  assert.equal(context.rfmGroup, 'LOYAL');
  assert.equal(context.lastOrder.total, 89.5);
  assert.deepEqual(context.location, { city: 'Lyon', country: 'France' });
});

test('buildCustomerContext falls back to first + last name', () => {
  const context = buildCustomerContext({ ...CUSTOMER, display_name: null });
  assert.equal(context.name, 'Marie Martin');
});

test('buildCustomerContext carries no phone and no street address', () => {
  const context = buildCustomerContext({
    ...CUSTOMER,
    phone: '+33600000000',
    default_address_formatted_area: '12 rue de la Paix, Lyon'
  });

  const serialised = JSON.stringify(context);
  assert.ok(!serialised.includes('33600000000'), 'phone must not reach the bundle');
  assert.ok(!serialised.includes('rue de la Paix'), 'street address must not reach the bundle');
});

test('buildCustomerContext returns null for a missing customer', () => {
  assert.equal(buildCustomerContext(null), null);
});

/**
 * The extraction guard. `tickets.resolved_context.customer` is written from
 * `buildOrderContext`, so if the shared shaping ever diverges from what the
 * order bundle used to emit, every stored context silently changes shape.
 */
test('the order bundle and the standalone lookup return the identical customer shape', () => {
  const order = { name: '#1009', order_number: 1009, line_items: [], fulfillments: [] };
  const fromOrder = buildOrderContext(order, CUSTOMER).customer;

  assert.deepEqual(fromOrder, buildCustomerContext(CUSTOMER));
});

test('buildAccountState separates never-activated from disabled', () => {
  const invited = buildAccountState({ ...CUSTOMER, state: 'INVITED' });
  assert.equal(invited.neverActivated, true);
  assert.equal(invited.canSignIn, false);
  assert.equal(invited.disabled, false);

  const disabled = buildAccountState({ ...CUSTOMER, state: 'DISABLED' });
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.neverActivated, false);

  const enabled = buildAccountState(CUSTOMER);
  assert.equal(enabled.canSignIn, true);
});

test('toPromptText withholds the email unless asked', () => {
  const context = buildCustomerContext(CUSTOMER);

  const withheld = toPromptText(context, buildAccountState(CUSTOMER));
  assert.ok(!withheld.includes('marie.martin@example.test'));

  const included = toPromptText(context, buildAccountState(CUSTOMER), { includeEmail: true });
  assert.ok(included.includes('marie.martin@example.test'));
});

test('toPromptText spells out an invited account rather than printing the enum', () => {
  const context = buildCustomerContext(CUSTOMER);
  const text = toPromptText(context, buildAccountState({ ...CUSTOMER, state: 'INVITED' }));

  assert.ok(text.includes('jamais été activé'));
  assert.ok(!text.includes('INVITED'));
});

test('toPromptText reports a customer with no orders rather than omitting the line', () => {
  const context = buildCustomerContext({
    ...CUSTOMER, number_of_orders: 0, last_order_name: null, last_order_at: null
  });
  const text = toPromptText(context, buildAccountState(CUSTOMER));

  assert.ok(text.includes('Aucune commande enregistrée'));
});

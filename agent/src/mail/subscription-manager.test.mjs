import assert from 'node:assert/strict';
import test from 'node:test';

import { hashClientState } from '../../../scripts/lib/mail-subscription-record.mjs';
import { RENEW_WITHIN_MS, manageSubscriptions, subscriptionPlan } from './subscription-manager.mjs';

const NOW = new Date('2026-09-28T10:00:00Z');
const inHours = (hours) => new Date(NOW.getTime() + hours * 3600_000).toISOString();

function fakes(rows = []) {
  const calls = [];
  return {
    calls,
    subscriptions: {
      forShop: async () => rows,
      saveCreated: async (row) => calls.push(['saveCreated', row]),
      saveRenewed: async (id, row) => calls.push(['saveRenewed', id, row]),
      saveError: async (id, error) => calls.push(['saveError', id, error.message])
    }
  };
}

function graph({ renew = { gone: false, expirationDateTime: inHours(70) }, createFails = null } = {}) {
  const calls = [];
  return {
    calls,
    async createSubscription(options) {
      calls.push(['create', options]);
      if (createFails) throw createFails;
      return { id: `sub-${options.folder}`, expirationDateTime: options.expirationDateTime };
    },
    async renewSubscription(id, expiry) {
      calls.push(['renew', id, expiry]);
      return renew;
    }
  };
}

test('the plan: create when missing, renew when flagged or close to expiry, otherwise keep', () => {
  assert.equal(subscriptionPlan(null, NOW), 'create');
  assert.equal(subscriptionPlan({ expires_at: inHours(48), needs_renewal: true }, NOW), 'renew');
  assert.equal(subscriptionPlan({ expires_at: inHours(RENEW_WITHIN_MS / 3600_000 - 1) }, NOW), 'renew');
  assert.equal(subscriptionPlan({ expires_at: 'garbage' }, NOW), 'renew');
  assert.equal(subscriptionPlan({ expires_at: inHours(48) }, NOW), 'keep');
});

test('DORMANT WITHOUT A WEBHOOK URL: nothing is read or created', async () => {
  const f = fakes();
  const g = graph();
  const totals = await manageSubscriptions({ graphClient: g, subscriptions: f.subscriptions, shopId: 's', webhookUrl: '', now: NOW });
  assert.deepEqual(totals, { created: 0, renewed: 0, kept: 0, failed: 0 });
  assert.equal(g.calls.length, 0);
});

test('both folders are subscribed, and only the secret\'s hash is stored', async () => {
  const f = fakes();
  const g = graph();
  const totals = await manageSubscriptions({
    graphClient: g,
    subscriptions: f.subscriptions,
    shopId: 's',
    webhookUrl: 'https://desk.example/api/webhooks/graph',
    now: NOW,
    newSecret: () => 'secret-1'
  });
  assert.equal(totals.created, 2);
  assert.deepEqual(g.calls.map(([, o]) => o.folder), ['inbox', 'sentitems']);
  assert.equal(g.calls[0][1].clientState, 'secret-1');
  const saved = f.calls.map(([, row]) => row);
  assert.deepEqual(saved.map((row) => row.folder), ['inbox', 'sentitems']);
  assert.equal(saved[0].clientStateHash, hashClientState('secret-1'));
  assert.ok(!JSON.stringify(saved).includes('secret-1'));
});

test('a subscription close to expiry is renewed; one Graph no longer has is recreated', async () => {
  const rows = [
    { id: 'r1', folder: 'inbox', subscription_id: 'sub-in', expires_at: inHours(2) },
    { id: 'r2', folder: 'sentitems', subscription_id: 'sub-out', expires_at: inHours(60) }
  ];
  const f = fakes(rows);
  const g = graph();
  const totals = await manageSubscriptions({ graphClient: g, subscriptions: f.subscriptions, shopId: 's', webhookUrl: 'https://x', now: NOW });
  assert.deepEqual(totals, { created: 0, renewed: 1, kept: 1, failed: 0 });
  assert.equal(g.calls[0][1], 'sub-in');

  const gone = graph({ renew: { gone: true } });
  const again = await manageSubscriptions({
    graphClient: gone,
    subscriptions: fakes(rows).subscriptions,
    shopId: 's',
    webhookUrl: 'https://x',
    now: NOW
  });
  assert.equal(again.created, 1);
});

test('A FAILURE IS LOUD AND NON-FATAL: logged at error level, written on the row, the poll goes on', async () => {
  const rows = [{ id: 'r1', folder: 'inbox', subscription_id: 'sub-in', expires_at: inHours(1) }];
  const f = fakes(rows);
  const g = graph({ renew: { gone: true }, createFails: new Error('Graph subscription create failed: ValidationError') });
  const errors = [];
  const totals = await manageSubscriptions({
    graphClient: g,
    subscriptions: f.subscriptions,
    shopId: 's',
    webhookUrl: 'https://x',
    now: NOW,
    logger: { error: (event, data) => errors.push([event, data]), warn() {}, info() {} }
  });
  assert.equal(totals.failed, 2);
  assert.deepEqual(errors.map(([event]) => event), ['mail.subscription_renew_failed', 'mail.subscription_renew_failed']);
  assert.deepEqual(f.calls, [['saveError', 'r1', 'Graph subscription create failed: ValidationError']]);
});

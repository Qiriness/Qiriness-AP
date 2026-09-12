import test from 'node:test';
import assert from 'node:assert/strict';

import { createAdminClient } from './dashboard-user-admin.mjs';

const URL_BASE = 'https://project.supabase.co';
const ADMIN = `${URL_BASE}/auth/v1/admin`;

/** A fake admin API that records what it was asked to do. */
function fakeAdmin({ users = [], fail = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = String(url).slice(ADMIN.length);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, method: init.method ?? 'GET', headers: init.headers ?? {}, body });
    if (fail) return json({ msg: fail }, 400);
    if (path.startsWith('/users?')) {
      const page = Number(new URLSearchParams(path.slice(path.indexOf('?'))).get('page'));
      return json({ users: page === 1 ? users : [] });
    }
    return json({ id: 'new-user', email: body?.email ?? 'x@y.z' });
  };
  return { client: createAdminClient({ url: URL_BASE, secretKey: 'sb_secret_x', fetch: fetchImpl }), calls };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const someone = (email, extra = {}) => ({ id: `id-${email}`, email, app_metadata: {}, ...extra });

test('the secret key travels as apikey, and every call says no-store', async () => {
  const { client, calls } = fakeAdmin({ users: [someone('a@q.com')] });
  await client.listUsers();
  assert.equal(calls[0].headers.apikey, 'sb_secret_x');
});

test('users come back sorted by address, across pages', async () => {
  const { client } = fakeAdmin({ users: [someone('z@q.com'), someone('a@q.com')] });
  const users = await client.listUsers();
  assert.deepEqual(users.map((user) => user.email), ['a@q.com', 'z@q.com']);
});

test('an address is matched case-insensitively', async () => {
  const { client } = fakeAdmin({ users: [someone('Ana@Qiriness.com')] });
  assert.equal((await client.findByEmail('  ana@qiriness.COM '))?.email, 'Ana@Qiriness.com');
  assert.equal(await client.findByEmail('nobody@qiriness.com'), null);
});

test('creating an account sets the role in app_metadata and confirms the address', async () => {
  const { client, calls } = fakeAdmin();
  await client.createUser({ email: ' New@Qiriness.com ', password: 'a-long-password', role: 'contact', displayName: 'New Person' });
  const call = calls.at(-1);
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/users');
  assert.deepEqual(call.body, {
    email: 'new@qiriness.com',
    password: 'a-long-password',
    email_confirm: true,
    app_metadata: { dashboard_role: 'contact' },
    user_metadata: { display_name: 'New Person' }
  });
});

test('an unknown role or a bad address is refused before any request', async () => {
  const { client, calls } = fakeAdmin();
  await assert.rejects(
    () => client.createUser({ email: 'a@q.com', password: 'x'.repeat(12), role: 'owner' }),
    /Unknown role/
  );
  await assert.rejects(
    () => client.createUser({ email: 'not-an-address', password: 'x'.repeat(12), role: 'contact' }),
    /Not an email address/
  );
  await assert.rejects(() => client.setRole('id-1', 'admin'), /Unknown role/);
  assert.equal(calls.length, 0);
});

test('changing a password, a role or a name each PUT only that', async () => {
  const { client, calls } = fakeAdmin();
  await client.setPassword('id-1', 'a-new-long-password');
  assert.deepEqual(calls.at(-1), {
    path: '/users/id-1',
    method: 'PUT',
    headers: calls.at(-1).headers,
    body: { password: 'a-new-long-password' }
  });
  await client.setRole('id-1', 'management');
  assert.deepEqual(calls.at(-1).body, { app_metadata: { dashboard_role: 'management' } });
  await client.setDisplayName('id-1', 'Ana');
  assert.deepEqual(calls.at(-1).body, { user_metadata: { display_name: 'Ana' } });
});

test('disabling bans for a century; enabling lifts it', async () => {
  const { client, calls } = fakeAdmin();
  await client.setDisabled('id-1', true);
  assert.deepEqual(calls.at(-1).body, { ban_duration: '876000h' });
  await client.setDisabled('id-1', false);
  assert.deepEqual(calls.at(-1).body, { ban_duration: 'none' });
});

test('a failed call names what was attempted, with Supabase\'s own message', async () => {
  const { client } = fakeAdmin({ fail: 'User already registered' });
  await assert.rejects(
    () => client.createUser({ email: 'a@q.com', password: 'x'.repeat(12), role: 'developer' }),
    /POST \/users failed: User already registered/
  );
});

test('a client cannot be made without the project url and the secret key', () => {
  assert.throws(() => createAdminClient({ url: URL_BASE }), /SUPABASE_SECRET_KEY/);
  assert.throws(() => createAdminClient({ secretKey: 'k' }), /SUPABASE_URL/);
});

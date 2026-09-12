import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  ROLES,
  ROLE_LABELS,
  SESSION_MAX_AGE_SECONDS,
  canAccessPath,
  canSeePanel,
  createAuthClient,
  dashboardRoleOf,
  decodeJwt,
  displayNameOf,
  fallbackPath,
  isBanned,
  isPlausibleEmail,
  needsRefresh,
  normaliseEmail,
  safeNextPath,
  sessionCookieOptions,
  sessionSecondsLeft,
  sessionStartedAt
} from './dashboard-auth.mjs';

// --- a Supabase-shaped project, signed with a real ES256 key -------------------

const URL_BASE = 'https://project.supabase.co';
const ISSUER = `${URL_BASE}/auth/v1`;
const KID = 'test-key-1';

const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const publicJwk = { ...(await crypto.subtle.exportKey('jwk', keyPair.publicKey)), kid: KID, alg: 'ES256', use: 'sig' };

const b64 = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const encodePart = (value) => b64(new TextEncoder().encode(JSON.stringify(value)));

async function makeToken(claims, { header = { alg: 'ES256', kid: KID, typ: 'JWT' }, sign = true } = {}) {
  const body = `${encodePart(header)}.${encodePart(claims)}`;
  if (!sign) return `${body}.${b64(new Uint8Array(64))}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, new TextEncoder().encode(body))
  );
  return `${body}.${b64(signature)}`;
}

const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);
const claimsFor = ({ sub = 'user-1', iat = NOW / 1000 - 60, exp = NOW / 1000 + 3600, amr } = {}) => ({
  iss: ISSUER,
  aud: 'authenticated',
  role: 'authenticated',
  sub,
  iat,
  exp,
  amr: amr ?? [{ method: 'password', timestamp: Math.floor(NOW / 1000) - 60 }]
});

/** A fetch that answers the three Auth endpoints this client uses. */
function fakeSupabase({ user, userStatus = 200, onCall } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = String(url).slice(ISSUER.length);
    calls.push({ path, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    onCall?.(path);
    if (path === '/.well-known/jwks.json') return json({ keys: [publicJwk] });
    if (path === '/user') {
      return userStatus === 200 ? json(user) : json({ msg: 'invalid' }, userStatus);
    }
    if (path.startsWith('/token?grant_type=password')) {
      const sent = JSON.parse(init.body);
      if (sent.password !== 'right-password') return json({ error_code: 'invalid_credentials' }, 400);
      return json({ access_token: 'at', refresh_token: 'rt', user });
    }
    if (path.startsWith('/token?grant_type=refresh_token')) {
      const sent = JSON.parse(init.body);
      if (sent.refresh_token !== 'good-refresh') return json({ msg: 'invalid' }, 400);
      return json({ access_token: 'at2', refresh_token: 'rt2', user });
    }
    if (path.startsWith('/logout')) return new Response(null, { status: 204 });
    return json({ msg: 'unexpected' }, 404);
  };
  return { fetchImpl, calls };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const activeUser = {
  id: 'user-1',
  email: 'dev@qiriness.com',
  app_metadata: { dashboard_role: 'developer' },
  user_metadata: { display_name: 'Dev Person' },
  banned_until: null
};

const client = (options = {}) =>
  createAuthClient({ url: URL_BASE, apiKey: 'sb_publishable_x', now: () => NOW, ...options });

// --- roles ---------------------------------------------------------------------

test('the three roles and their labels are the ones the CLI and the UI use', () => {
  assert.deepEqual(ROLES, ['developer', 'management', 'contact']);
  assert.deepEqual(Object.keys(ROLE_LABELS).sort(), [...ROLES].sort());
});

test('contact cannot open Sales; the other two roles can', () => {
  assert.equal(canAccessPath('contact', '/insights/sales'), false);
  assert.equal(canAccessPath('contact', '/insights/sales/anything'), false);
  assert.equal(canSeePanel('contact', 'sales'), false);
  for (const role of ['developer', 'management']) {
    assert.equal(canAccessPath(role, '/insights/sales'), true);
    assert.equal(canSeePanel(role, 'sales'), true);
  }
});

test('every role may open the other panels, and the rest of the app', () => {
  for (const role of ROLES) {
    for (const panel of ['fulfilment', 'support', 'customers', 'agent']) {
      assert.equal(canSeePanel(role, panel), true, `${role} should see ${panel}`);
    }
    assert.equal(canAccessPath(role, '/tickets'), true);
    assert.equal(canAccessPath(role, '/api/tickets/abc'), true);
  }
});

test('an unknown or missing role may open nothing', () => {
  for (const role of [null, undefined, '', 'admin', 'DEVELOPER']) {
    assert.equal(canAccessPath(role, '/tickets'), false);
    assert.equal(canAccessPath(role, '/insights/fulfilment'), false);
  }
});

test('a role lands on the first panel it may open', () => {
  assert.equal(fallbackPath('developer'), '/insights/sales');
  assert.equal(fallbackPath('management'), '/insights/sales');
  assert.equal(fallbackPath('contact'), '/insights/fulfilment');
});

test('a "sales" path outside Insights is not caught by the rule', () => {
  assert.equal(canAccessPath('contact', '/insights/salesforce'), true);
});

// --- where a sign-in may send you ----------------------------------------------

test('only a same-site path survives as the post-login destination', () => {
  assert.equal(safeNextPath('/tickets?status=open'), '/tickets?status=open');
  assert.equal(safeNextPath('//evil.example/x'), '/insights');
  assert.equal(safeNextPath('/\\evil.example'), '/insights');
  assert.equal(safeNextPath('https://evil.example'), '/insights');
  assert.equal(safeNextPath('/login?next=/x'), '/insights');
  assert.equal(safeNextPath('/api/auth/me'), '/insights');
  assert.equal(safeNextPath(undefined), '/insights');
  assert.equal(safeNextPath('/x', '/insights/fulfilment'), '/x');
});

// --- reading a Supabase user ----------------------------------------------------

test('the role is read from app_metadata only, and must be one we know', () => {
  assert.equal(dashboardRoleOf(activeUser), 'developer');
  assert.equal(dashboardRoleOf({ app_metadata: { dashboard_role: 'owner' } }), null);
  assert.equal(dashboardRoleOf({ app_metadata: {} }), null);
  assert.equal(dashboardRoleOf({}), null);
  // user_metadata is writable by the user themselves: it must never be a role.
  assert.equal(dashboardRoleOf({ user_metadata: { dashboard_role: 'developer' } }), null);
});

test('a ban is only a ban while it lasts', () => {
  assert.equal(isBanned({ banned_until: new Date(NOW + 60_000).toISOString() }, NOW), true);
  assert.equal(isBanned({ banned_until: new Date(NOW - 60_000).toISOString() }, NOW), false);
  assert.equal(isBanned({ banned_until: null }, NOW), false);
  assert.equal(isBanned({}, NOW), false);
});

test('the display name is optional and trimmed', () => {
  assert.equal(displayNameOf(activeUser), 'Dev Person');
  assert.equal(displayNameOf({ user_metadata: { display_name: '   ' } }), null);
  assert.equal(displayNameOf({}), null);
});

test('emails are compared lower-cased and trimmed', () => {
  assert.equal(normaliseEmail('  Dev@Qiriness.COM '), 'dev@qiriness.com');
  assert.equal(normaliseEmail(null), '');
  assert.equal(isPlausibleEmail('dev@qiriness.com'), true);
  assert.equal(isPlausibleEmail('not-an-address'), false);
});

// --- session timing -------------------------------------------------------------

test('the session is counted from the password, not from the last refresh', async () => {
  const signedInAt = Math.floor(NOW / 1000) - 3 * 3600;
  const payload = claimsFor({ amr: [{ method: 'password', timestamp: signedInAt }] });
  assert.equal(sessionStartedAt(payload), signedInAt * 1000);
  assert.equal(sessionSecondsLeft(payload, NOW), SESSION_MAX_AGE_SECONDS - 3 * 3600);
});

test('a session with no amr falls back to the token issue time', () => {
  const payload = { iat: Math.floor(NOW / 1000) - 600 };
  assert.equal(sessionStartedAt(payload), (Math.floor(NOW / 1000) - 600) * 1000);
});

test('a token is refreshed slightly before it expires, not after', () => {
  assert.equal(needsRefresh({ exp: NOW / 1000 + 3600 }, NOW), false);
  assert.equal(needsRefresh({ exp: NOW / 1000 + 60 }, NOW), true);
  assert.equal(needsRefresh({ exp: NOW / 1000 - 1 }, NOW), true);
  assert.equal(needsRefresh({}, NOW), true);
});

test('decodeJwt reads claims without judging them, and refuses rubbish', () => {
  assert.equal(decodeJwt('not.a.jwt'), null);
  assert.equal(decodeJwt(''), null);
  assert.equal(decodeJwt(`${encodePart({ alg: 'ES256' })}.${encodePart({ sub: 'x' })}.sig`).payload.sub, 'x');
});

test('both cookies are HttpOnly, Lax, and secure only where TLS is', () => {
  const options = sessionCookieOptions({ secure: true, maxAge: 120 });
  assert.equal(options.httpOnly, true);
  assert.equal(options.sameSite, 'lax');
  assert.equal(options.secure, true);
  assert.equal(options.path, '/');
  assert.equal(options.maxAge, 120);
  assert.equal(sessionCookieOptions({ secure: false }).maxAge, SESSION_MAX_AGE_SECONDS);
  assert.equal(ACCESS_COOKIE !== REFRESH_COOKIE, true);
});

// --- verifying an access token ---------------------------------------------------

test('a well-formed token for an active user verifies, and names them', async () => {
  const { fetchImpl } = fakeSupabase({ user: activeUser });
  const auth = client({ fetch: fetchImpl });
  const result = await auth.verifyAccessToken(await makeToken(claimsFor()));
  assert.equal(result.ok, true);
  assert.deepEqual(result.user, {
    id: 'user-1',
    email: 'dev@qiriness.com',
    role: 'developer',
    displayName: 'Dev Person'
  });
});

test('a tampered signature is refused without asking Supabase', async () => {
  const { fetchImpl, calls } = fakeSupabase({ user: activeUser });
  const auth = client({ fetch: fetchImpl });
  const result = await auth.verifyAccessToken(await makeToken(claimsFor(), { sign: false }));
  assert.deepEqual(result, { ok: false, reason: 'invalid' });
  assert.equal(calls.some((call) => call.path === '/user'), false);
});

test('a token from another issuer is refused', async () => {
  const { fetchImpl } = fakeSupabase({ user: activeUser });
  const auth = client({ fetch: fetchImpl });
  const token = await makeToken({ ...claimsFor(), iss: 'https://someone-else.supabase.co/auth/v1' });
  assert.deepEqual(await auth.verifyAccessToken(token), { ok: false, reason: 'invalid' });
});

test('a service token (role other than authenticated) is refused', async () => {
  const { fetchImpl } = fakeSupabase({ user: activeUser });
  const auth = client({ fetch: fetchImpl });
  const token = await makeToken({ ...claimsFor(), role: 'service_role' });
  assert.deepEqual(await auth.verifyAccessToken(token), { ok: false, reason: 'invalid' });
});

test('an expired access token says so — the one case a refresh fixes', async () => {
  const { fetchImpl } = fakeSupabase({ user: activeUser });
  const auth = client({ fetch: fetchImpl });
  const token = await makeToken(claimsFor({ exp: NOW / 1000 - 1 }));
  assert.deepEqual(await auth.verifyAccessToken(token), { ok: false, reason: 'expired' });
});

test('a session older than twelve hours cannot be refreshed back to life', async () => {
  const { fetchImpl } = fakeSupabase({ user: activeUser });
  const auth = client({ fetch: fetchImpl });
  const token = await makeToken(
    claimsFor({ amr: [{ method: 'password', timestamp: Math.floor(NOW / 1000) - SESSION_MAX_AGE_SECONDS - 1 }] })
  );
  assert.deepEqual(await auth.verifyAccessToken(token), { ok: false, reason: 'session_expired' });
});

test('a signed-out session is refused: Supabase no longer knows the token', async () => {
  const { fetchImpl } = fakeSupabase({ user: activeUser, userStatus: 401 });
  const auth = client({ fetch: fetchImpl });
  assert.deepEqual(await auth.verifyAccessToken(await makeToken(claimsFor())), { ok: false, reason: 'revoked' });
});

test('a banned user is refused even with a valid, unexpired token', async () => {
  const banned = { ...activeUser, banned_until: new Date(NOW + 3600_000).toISOString() };
  const { fetchImpl } = fakeSupabase({ user: banned });
  const auth = client({ fetch: fetchImpl });
  assert.deepEqual(await auth.verifyAccessToken(await makeToken(claimsFor())), { ok: false, reason: 'disabled' });
});

test('an account with no dashboard role is refused — a stray sign-up gets nothing', async () => {
  const stranger = { id: 'user-2', email: 'stranger@example.com', app_metadata: {}, user_metadata: {} };
  const { fetchImpl } = fakeSupabase({ user: stranger });
  const auth = client({ fetch: fetchImpl });
  assert.deepEqual(await auth.verifyAccessToken(await makeToken(claimsFor())), { ok: false, reason: 'no_role' });
});

test('the role comes from Supabase, not from the token: a re-role takes effect', async () => {
  const { fetchImpl } = fakeSupabase({ user: { ...activeUser, app_metadata: { dashboard_role: 'contact' } } });
  const auth = client({ fetch: fetchImpl });
  // The token still carries developer in its own app_metadata claim.
  const token = await makeToken({ ...claimsFor(), app_metadata: { dashboard_role: 'developer' } });
  const result = await auth.verifyAccessToken(token);
  assert.equal(result.user.role, 'contact');
});

test('Supabase is asked once a minute per token, not once a request', async () => {
  const { fetchImpl, calls } = fakeSupabase({ user: activeUser });
  let clock = NOW;
  const auth = client({ fetch: fetchImpl, now: () => clock });
  const token = await makeToken(claimsFor());
  await auth.verifyAccessToken(token);
  await auth.verifyAccessToken(token);
  await auth.verifyAccessToken(token);
  assert.equal(calls.filter((call) => call.path === '/user').length, 1);

  clock += 61_000;
  await auth.verifyAccessToken(token);
  assert.equal(calls.filter((call) => call.path === '/user').length, 2);
});

test('forgetting a token drops it from the cache', async () => {
  const { fetchImpl, calls } = fakeSupabase({ user: activeUser });
  const auth = client({ fetch: fetchImpl });
  const token = await makeToken(claimsFor());
  await auth.verifyAccessToken(token);
  auth.forget(token);
  await auth.verifyAccessToken(token);
  assert.equal(calls.filter((call) => call.path === '/user').length, 2);
});

test('nothing at all is refused as invalid, cheaply', async () => {
  const { fetchImpl, calls } = fakeSupabase({ user: activeUser });
  const auth = client({ fetch: fetchImpl });
  for (const token of [null, undefined, '', 'garbage', 42]) {
    assert.deepEqual(await auth.verifyAccessToken(token), { ok: false, reason: 'invalid' });
  }
  assert.equal(calls.length, 0);
});

// --- the three calls -------------------------------------------------------------

test('signing in posts the password grant and lower-cases the address', async () => {
  const { fetchImpl, calls } = fakeSupabase({ user: activeUser });
  const auth = client({ fetch: fetchImpl });
  const result = await auth.signIn('  DEV@qiriness.com ', 'right-password');
  assert.equal(result.ok, true);
  assert.equal(result.session.access_token, 'at');
  const call = calls.at(-1);
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/token?grant_type=password');
  assert.equal(call.headers.apikey, 'sb_publishable_x');
  assert.deepEqual(JSON.parse(call.body), { email: 'dev@qiriness.com', password: 'right-password' });
});

test('a wrong password comes back as a refusal, with the reason kept for the log', async () => {
  const { fetchImpl } = fakeSupabase({ user: activeUser });
  const auth = client({ fetch: fetchImpl });
  const result = await auth.signIn('dev@qiriness.com', 'wrong');
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.code, 'invalid_credentials');
});

test('refreshing trades one token pair for the next; a stale one is refused', async () => {
  const { fetchImpl } = fakeSupabase({ user: activeUser });
  const auth = client({ fetch: fetchImpl });
  const good = await auth.refresh('good-refresh');
  assert.equal(good.ok, true);
  assert.deepEqual([good.session.access_token, good.session.refresh_token], ['at2', 'rt2']);
  assert.equal((await auth.refresh('already-used')).ok, false);
});

test('signing out tells Supabase, with the token as the bearer', async () => {
  const { fetchImpl, calls } = fakeSupabase({ user: activeUser });
  const auth = client({ fetch: fetchImpl });
  await auth.signOut('some-access-token');
  const call = calls.at(-1);
  assert.equal(call.path, '/logout?scope=local');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.Authorization, 'Bearer some-access-token');
});

test('a client cannot be made without a project url and key', () => {
  assert.throws(() => createAuthClient({ url: URL_BASE }), /SUPABASE_PUBLISHABLE_KEY/);
  assert.throws(() => createAuthClient({ apiKey: 'k' }), /SUPABASE_URL/);
});

test('an unreachable JWKS does not lock everyone out — Supabase still decides', async () => {
  const { fetchImpl } = fakeSupabase({
    user: activeUser,
    onCall: (path) => {
      if (path === '/.well-known/jwks.json') throw new Error('network down');
    }
  });
  const auth = client({ fetch: fetchImpl });
  const result = await auth.verifyAccessToken(await makeToken(claimsFor()));
  assert.equal(result.ok, true);
});

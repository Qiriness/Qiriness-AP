/**
 * Who may see what on the dashboard, and the Supabase Auth session that says
 * who is asking.
 *
 * ISOMORPHIC ON PURPOSE: this runs in Next's edge middleware (every request),
 * in the Node route handlers, and under `node --test`. So it uses only Web APIs
 * — `fetch`, `crypto.subtle`, `TextEncoder`, `atob` — and nothing from `node:`.
 *
 * SUPABASE AUTH HOLDS THE ACCOUNTS. `auth.users` stores the email, the password
 * (hashed by Supabase) and, in `app_metadata.dashboard_role`, the role. It is
 * `app_metadata` and not `user_metadata` because only the service key can write
 * app_metadata: a signed-in user can edit their own user_metadata, and a role a
 * user can edit is not a role.
 *
 * ROLES AND THEIR PERMISSIONS ARE CODE. What each role may open is decided
 * here, in one table, so the middleware, the Insights tabs and the page guard
 * cannot disagree. A user without a known role may open nothing — which is what
 * makes a stray Supabase sign-up harmless.
 *
 * A REQUEST IS CHECKED TWICE, CHEAPLY. The access token is a short-lived
 * (1 hour) JWT signed by Supabase with ES256; its signature and expiry are
 * checked locally against the project's public keys, so a forged or stale
 * cookie never costs a network call. A valid one is then confirmed against
 * `/auth/v1/user` — cached for a minute per token — because only Supabase knows
 * whether the account has since been banned, re-roled, or signed out. That is
 * the revocation window: at most a minute, not the life of the token.
 */

// --- roles ---------------------------------------------------------------------

export const ROLES = Object.freeze(['developer', 'management', 'contact']);

export const ROLE_LABELS = Object.freeze({
  developer: 'Developer',
  management: 'Management',
  contact: 'Contact team'
});

/** Where the role lives on a Supabase user. Service-key writable only. */
export const ROLE_CLAIM = 'dashboard_role';

/**
 * Paths a role may NOT open. Everything else is open to every signed-in role.
 *
 * The contact team handles customer mail and has no business with revenue, so
 * Insights → Sales is closed to it (the owner's rule, 2026-09-11). The
 * management chat on Home — the page and its API — is for Management and
 * Developer only (2026-09-14): it answers revenue questions too, and more
 * freely than any panel. Developer and Management are identical for now; they
 * are separate roles so they can diverge without a migration.
 */
const DENIED = Object.freeze({
  developer: [],
  management: [],
  contact: ['/insights/sales', '/home', '/api/chat']
});

/** May this role use the management chat? What the sidebar asks before drawing Home. */
export function canUseManagementChat(role) {
  return canAccessPath(role, '/home');
}

/** The Insights panels a role may see — what the nav renders. */
export function canSeePanel(role, panel) {
  return canAccessPath(role, `/insights/${panel}`);
}

/**
 * May `role` open `pathname`? An unknown role may open nothing: a Supabase user
 * with no `dashboard_role` — a stray sign-up, or an account half set up — is
 * not a visitor with reduced rights, it is not a dashboard user at all.
 */
export function canAccessPath(role, pathname) {
  if (!ROLES.includes(role)) return false;
  const path = String(pathname || '/');
  return !DENIED[role].some((denied) => path === denied || path.startsWith(`${denied}/`));
}

/** Where a role lands when it asks for a page it may not open. */
export function fallbackPath(role) {
  return canAccessPath(role, '/insights/sales') ? '/insights/sales' : '/insights/fulfilment';
}

/**
 * Only a same-site path may be a post-login destination: `/tickets?x=1` yes,
 * `//evil.example` and `https://…` no. Anything else lands on the default.
 */
export function safeNextPath(next, fallback = '/insights') {
  const value = typeof next === 'string' ? next : '';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  if (value.startsWith('/login') || value.startsWith('/api/')) return fallback;
  return value;
}

export function normaliseEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

export function isPlausibleEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// --- the session cookies -------------------------------------------------------

export const ACCESS_COOKIE = 'qos_at';
export const REFRESH_COOKIE = 'qos_rt';

/**
 * A working day, then sign in again — counted from when the password was typed,
 * not from the last refresh, so a tab left open cannot renew itself forever.
 */
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

/** Refresh this long before the access token expires, rather than after. */
const REFRESH_SKEW_SECONDS = 120;

/** The Set-Cookie attributes both session cookies are written with. */
export function sessionCookieOptions({ secure, maxAge = SESSION_MAX_AGE_SECONDS }) {
  return {
    httpOnly: true,
    sameSite: /** @type {'lax'} */ ('lax'),
    secure: Boolean(secure),
    path: '/',
    maxAge
  };
}

// --- reading a Supabase user ---------------------------------------------------

/** The dashboard role on a Supabase user, or null if it is missing or unknown. */
export function dashboardRoleOf(user) {
  const role = user?.app_metadata?.[ROLE_CLAIM];
  return ROLES.includes(role) ? role : null;
}

export function isBanned(user, now = Date.now()) {
  const until = user?.banned_until;
  return Boolean(until) && Date.parse(until) > now;
}

export function displayNameOf(user) {
  const name = user?.user_metadata?.display_name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

// --- the access token ----------------------------------------------------------

function fromBase64Url(text) {
  const padded = String(text).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(text).length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The claims a token carries, unverified — for timing decisions only. */
export function decodeJwt(token) {
  try {
    const [header, payload, signature] = String(token).split('.');
    if (!header || !payload || !signature) return null;
    return {
      header: JSON.parse(new TextDecoder().decode(fromBase64Url(header))),
      payload: JSON.parse(new TextDecoder().decode(fromBase64Url(payload)))
    };
  } catch {
    return null;
  }
}

/**
 * When the password was actually typed. Supabase records each authentication in
 * `amr`; a refresh carries the original entry forward, which is what makes this
 * a session age rather than a token age.
 */
export function sessionStartedAt(payload) {
  const stamps = Array.isArray(payload?.amr)
    ? payload.amr.map((entry) => Number(entry?.timestamp)).filter((value) => Number.isFinite(value))
    : [];
  if (stamps.length) return Math.max(...stamps) * 1000;
  return Number.isFinite(payload?.iat) ? payload.iat * 1000 : 0;
}

/** Seconds of session left before a new sign-in is required. */
export function sessionSecondsLeft(payload, now = Date.now()) {
  const started = sessionStartedAt(payload);
  if (!started) return 0;
  return Math.max(0, Math.round((started + SESSION_MAX_AGE_SECONDS * 1000 - now) / 1000));
}

/** True when the access token has expired, or is about to. */
export function needsRefresh(payload, now = Date.now()) {
  return !Number.isFinite(payload?.exp) || payload.exp * 1000 - REFRESH_SKEW_SECONDS * 1000 <= now;
}

// --- the client ----------------------------------------------------------------

/**
 * Everything this app does with Supabase Auth, over the REST API.
 *
 * Deliberately not `@supabase/supabase-js`: the rest of this codebase talks to
 * Supabase through its own small REST client (`supabase-rest-client.mjs`) for
 * the same reason — one dependency fewer, and every request visible here,
 * including the `cache: 'no-store'` that Next's patched fetch otherwise makes
 * optional.
 *
 * `fetchImpl` and `now` are injectable so the tests can drive the whole thing
 * without a network or a clock.
 */
export function createAuthClient({
  url,
  apiKey,
  fetch: fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  verifyTtlMs = 60_000,
  jwksTtlMs = 10 * 60_000
} = {}) {
  if (!url || !apiKey) throw new Error('Supabase Auth needs SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.');
  const base = `${String(url).replace(/\/$/, '')}/auth/v1`;
  const issuer = base;
  const headers = (extra = {}) => ({ apikey: apiKey, ...extra });
  const call = (path, init = {}) => fetchImpl(`${base}${path}`, { cache: 'no-store', ...init });

  /** @type {Map<string, {result: object, until: number}>} */
  const verified = new Map();
  let jwks = { keys: new Map(), until: 0 };

  async function loadKeys(force = false) {
    if (!force && jwks.until > now() && jwks.keys.size) return jwks.keys;
    try {
      const response = await call('/.well-known/jwks.json', { headers: headers() });
      const body = await response.json();
      const keys = new Map();
      for (const jwk of body?.keys ?? []) {
        // ES256 only. A project on the legacy shared HS256 secret publishes no
        // usable key here; those tokens fall through to the Supabase check.
        if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.kid) continue;
        keys.set(
          jwk.kid,
          await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
        );
      }
      jwks = { keys, until: now() + jwksTtlMs };
    } catch {
      // A JWKS that cannot be fetched must not lock everyone out: the Supabase
      // check below is authoritative on its own.
      jwks = { keys: jwks.keys, until: now() + 10_000 };
    }
    return jwks.keys;
  }

  /** true / false / null, where null means "no key for this token, cannot say". */
  async function checkSignature(token, header) {
    if (header?.alg !== 'ES256' || !header?.kid) return null;
    let keys = await loadKeys();
    let key = keys.get(header.kid);
    if (!key) {
      keys = await loadKeys(true);
      key = keys.get(header.kid);
    }
    if (!key) return null;
    const [encodedHeader, encodedPayload, signature] = String(token).split('.');
    return crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      fromBase64Url(signature),
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
    );
  }

  /** The account as Supabase holds it right now — the authoritative read. */
  async function getUser(accessToken) {
    const response = await call('/user', { headers: headers({ Authorization: `Bearer ${accessToken}` }) });
    if (!response.ok) return null;
    return response.json().catch(() => null);
  }

  function remember(token, result, ttl) {
    if (verified.size > 200) verified.clear();
    verified.set(token, { result, until: now() + ttl });
    return result;
  }

  return {
    /** POST the password. `{ok, session}` on success; never says which half was wrong. */
    async signIn(email, password) {
      const response = await call('/token?grant_type=password', {
        method: 'POST',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ email: normaliseEmail(email), password })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) return { ok: false, status: response.status, code: body?.error_code ?? body?.error ?? null };
      return { ok: true, session: body };
    },

    /** Trade a refresh token for a new pair. Supabase rotates them on every use. */
    async refresh(refreshToken) {
      const response = await call('/token?grant_type=refresh_token', {
        method: 'POST',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ refresh_token: refreshToken })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) return { ok: false, status: response.status };
      return { ok: true, session: body };
    },

    /** End this session at Supabase, so its refresh token cannot be used again. */
    async signOut(accessToken) {
      if (!accessToken) return;
      verified.delete(accessToken);
      await call('/logout?scope=local', {
        method: 'POST',
        headers: headers({ Authorization: `Bearer ${accessToken}` })
      }).catch(() => undefined);
    },

    getUser,

    /**
     * Who this access token belongs to, or why it is refused.
     *
     * `{ok: true, user}` — or `{ok: false, reason}` where the reason separates
     * the one case a refresh can fix (`expired`) from the ones it cannot
     * (`invalid`, `session_expired`, `revoked`, `disabled`, `no_role`).
     */
    async verifyAccessToken(token) {
      if (!token || typeof token !== 'string') return { ok: false, reason: 'invalid' };
      const cached = verified.get(token);
      if (cached && cached.until > now()) return cached.result;

      const decoded = decodeJwt(token);
      if (!decoded) return { ok: false, reason: 'invalid' };
      const { header, payload } = decoded;

      if (payload.iss !== issuer) return { ok: false, reason: 'invalid' };
      if (payload.role !== 'authenticated') return { ok: false, reason: 'invalid' };
      if (await checkSignature(token, header) === false) return { ok: false, reason: 'invalid' };
      if (!Number.isFinite(payload.exp) || payload.exp * 1000 <= now()) return { ok: false, reason: 'expired' };
      if (sessionSecondsLeft(payload, now()) <= 0) return { ok: false, reason: 'session_expired' };

      // Supabase is asked last, and only about tokens that already look right.
      const user = await getUser(token);
      if (!user?.id) return remember(token, { ok: false, reason: 'revoked' }, 5_000);
      if (isBanned(user, now())) return remember(token, { ok: false, reason: 'disabled' }, 5_000);
      const role = dashboardRoleOf(user);
      if (!role) return remember(token, { ok: false, reason: 'no_role' }, 5_000);

      return remember(
        token,
        {
          ok: true,
          user: { id: user.id, email: user.email ?? null, role, displayName: displayNameOf(user) },
          payload
        },
        Math.min(verifyTtlMs, Math.max(0, payload.exp * 1000 - now()))
      );
    },

    /** Drop a token from the verification cache (after sign-out, say). */
    forget(token) {
      verified.delete(token);
    }
  };
}

/**
 * The client this runtime uses, made once. The edge middleware and the Node
 * server each get their own — and so each its own one-minute cache, which is
 * the intended cost of not sharing state between them.
 */
let shared = null;
export function authClient(env = globalThis.process?.env ?? {}) {
  const url = env.SUPABASE_URL;
  const apiKey = env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !apiKey) return null;
  if (!shared || shared.url !== url) shared = { url, client: createAuthClient({ url, apiKey }) };
  return shared.client;
}

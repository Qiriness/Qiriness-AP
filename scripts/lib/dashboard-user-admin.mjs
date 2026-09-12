/**
 * Managing dashboard accounts in Supabase Auth, with the secret key.
 *
 * THE ONLY WRITER OF `auth.users` IN THIS REPO, and it is reachable from one
 * place: `npm run users`. There is no sign-up page and no self-service reset — a
 * page that creates accounts is a page somebody else can find.
 *
 * NEVER IMPORT THIS FROM THE WEB APP. It carries the secret key, which can do
 * anything to any account; the dashboard only ever holds a user's own access
 * token (`dashboard-auth.mjs`).
 *
 * The role lives in `app_metadata.dashboard_role`, which only this key can
 * write. "Disabled" is Supabase's own ban, set far enough out to be permanent;
 * accounts are banned rather than deleted so an audit row still resolves to a
 * person.
 */

import { ROLE_CLAIM, ROLES, isPlausibleEmail, normaliseEmail } from './dashboard-auth.mjs';

/** Supabase wants a duration; a century reads as "until somebody lifts it". */
const FOREVER = '876000h';

export function createAdminClient({ url, secretKey, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (!url || !secretKey) throw new Error('Managing dashboard users needs SUPABASE_URL and SUPABASE_SECRET_KEY.');
  const base = `${String(url).replace(/\/$/, '')}/auth/v1/admin`;

  async function call(path, init = {}) {
    const response = await fetchImpl(`${base}${path}`, {
      ...init,
      cache: 'no-store',
      headers: {
        apikey: secretKey,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {})
      }
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`Supabase Auth ${init.method ?? 'GET'} ${path} failed: ${body?.msg || body?.message || `HTTP ${response.status}`}`);
    }
    return body;
  }

  async function listUsers() {
    const all = [];
    const perPage = 200;
    for (let page = 1; page <= 50; page += 1) {
      const body = await call(`/users?page=${page}&per_page=${perPage}`);
      const users = body?.users ?? [];
      all.push(...users);
      if (users.length < perPage) break;
    }
    return all.sort((a, b) => String(a.email).localeCompare(String(b.email)));
  }

  return {
    listUsers,

    async findByEmail(email) {
      const address = normaliseEmail(email);
      const users = await listUsers();
      return users.find((user) => normaliseEmail(user.email) === address) ?? null;
    },

    async createUser({ email, password, role, displayName = null }) {
      const address = normaliseEmail(email);
      if (!isPlausibleEmail(address)) throw new Error(`Not an email address: ${email}`);
      if (!ROLES.includes(role)) throw new Error(`Unknown role "${role}". Use one of: ${ROLES.join(', ')}.`);
      return call('/users', {
        method: 'POST',
        body: JSON.stringify({
          email: address,
          password,
          // There is no mailbox flow here: the account is created by someone who
          // already knows the address, so waiting on a confirmation email would
          // only leave the account unusable.
          email_confirm: true,
          app_metadata: { [ROLE_CLAIM]: role },
          user_metadata: displayName ? { display_name: displayName } : {}
        })
      });
    },

    setPassword(id, password) {
      return call(`/users/${id}`, { method: 'PUT', body: JSON.stringify({ password }) });
    },

    // async so a refused role rejects like every other failure here, rather
    // than throwing synchronously out of a call that looks like a promise.
    async setRole(id, role) {
      if (!ROLES.includes(role)) throw new Error(`Unknown role "${role}". Use one of: ${ROLES.join(', ')}.`);
      return call(`/users/${id}`, { method: 'PUT', body: JSON.stringify({ app_metadata: { [ROLE_CLAIM]: role } }) });
    },

    setDisplayName(id, displayName) {
      return call(`/users/${id}`, { method: 'PUT', body: JSON.stringify({ user_metadata: { display_name: displayName } }) });
    },

    setDisabled(id, disabled) {
      return call(`/users/${id}`, { method: 'PUT', body: JSON.stringify({ ban_duration: disabled ? FOREVER : 'none' }) });
    },

    /** Only for throwaway accounts a test made; people are disabled, not deleted. */
    deleteUser(id) {
      return call(`/users/${id}`, { method: 'DELETE' });
    }
  };
}

/**
 * DEV STORE ONLY — the whole `scripts/dev-store/` folder exists for testing the
 * storefront advisor on a Shopify dev store and is deleted with it
 * (docs/storefront-chatbot.md § Dev store: setup and removal).
 *
 * Which store is the dev store, and the guards that keep every dev command off
 * production:
 *   - the domain is STOREFRONT_DEV_STORE_DOMAIN, else the first
 *     STOREFRONT_CHAT_ALLOWED_SHOPS entry;
 *   - it must be in STOREFRONT_CHAT_ALLOWED_SHOPS;
 *   - it must not be SHOPIFY_STORE_DOMAIN (the dashboard's production shop);
 *   - the credentials are the ADVISOR app's (STOREFRONT_APP_CLIENT_ID/SECRET),
 *     never the production app's, and production's admin token is blanked.
 */

import { existsSync, readFileSync } from 'node:fs';

/** The advisor app's client id: not a secret, and already in its own toml. */
export function advisorClientId(env, tomlPath = new URL('../../storefront-app/shopify.app.toml', import.meta.url)) {
  if (env.STOREFRONT_APP_CLIENT_ID) return env.STOREFRONT_APP_CLIENT_ID;
  if (!existsSync(tomlPath)) return '';
  return readFileSync(tomlPath, 'utf8').match(/^client_id\s*=\s*"([^"]+)"/m)?.[1] ?? '';
}

export function devStoreTarget(env) {
  env = { ...env, STOREFRONT_APP_CLIENT_ID: advisorClientId(env) };
  const allowed = String(env.STOREFRONT_CHAT_ALLOWED_SHOPS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const domain = String(env.STOREFRONT_DEV_STORE_DOMAIN || allowed[0] || '').trim().toLowerCase();
  const production = String(env.SHOPIFY_STORE_DOMAIN ?? '').trim().toLowerCase();

  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)) throw new Error('No dev store: set STOREFRONT_DEV_STORE_DOMAIN or STOREFRONT_CHAT_ALLOWED_SHOPS.');
  if (!allowed.includes(domain)) throw new Error(`${domain} is not in STOREFRONT_CHAT_ALLOWED_SHOPS.`);
  if (domain === production) throw new Error(`${domain} is the production store (SHOPIFY_STORE_DOMAIN). Refusing.`);
  if (!env.STOREFRONT_APP_CLIENT_ID || !env.STOREFRONT_APP_CLIENT_SECRET) throw new Error('STOREFRONT_APP_CLIENT_ID and STOREFRONT_APP_CLIENT_SECRET are required.');
  if (env.STOREFRONT_APP_CLIENT_ID === env.SHOPIFY_CLIENT_ID) throw new Error('The advisor app credentials equal the production app credentials. Refusing.');

  return {
    domain,
    /** The environment a sync child runs with: the dev store, the advisor app, development. */
    childEnv: {
      ...env,
      SHOPIFY_STORE_DOMAIN: domain,
      SHOPIFY_CLIENT_ID: env.STOREFRONT_APP_CLIENT_ID,
      SHOPIFY_CLIENT_SECRET: env.STOREFRONT_APP_CLIENT_SECRET,
      // Blank, not absent: loadEnv never overwrites a set key, so production's
      // token in .env.local cannot fill it back in.
      SHOPIFY_ADMIN_API_ACCESS_TOKEN: '',
      SHOPIFY_WEBHOOK_SECRET: '',
      APP_ENV: 'development'
    }
  };
}

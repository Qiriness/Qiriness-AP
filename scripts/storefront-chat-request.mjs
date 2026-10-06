import { loadEnv } from './lib/sync-config.mjs';
import { signAppProxyQuery } from './lib/storefront-chat/app-proxy-signature.mjs';

// Send one message to the storefront chat endpoint exactly as the Shopify app
// proxy would: same query parameters, signed with STOREFRONT_APP_CLIENT_SECRET.
// Proves backend -> agent -> log without a store, a theme or a tunnel.
//
//   npm run storefront:chat -- --message "Bonjour"
//   npm run storefront:chat -- --action find_product --session <uuid>
//   npm run storefront:chat -- --session <uuid> --message Sérum --choice Sérum   (a clicked chip)
//   npm run storefront:chat -- --unsigned          (expect 401)
//   npm run storefront:chat -- --shop other.myshopify.com   (expect 403)
//
// --url defaults to http://localhost:3000/api/storefront/chat (`npm --prefix web run dev`).
// --shop defaults to the first STOREFRONT_CHAT_ALLOWED_SHOPS entry.
// Writes one session and two messages per call to the configured database.

const env = loadEnv();
const url = new URL(valueOf('--url') ?? 'http://localhost:3000/api/storefront/chat');
const shop = valueOf('--shop') ?? String(env.STOREFRONT_CHAT_ALLOWED_SHOPS ?? '').split(',')[0].trim();
const secret = env.STOREFRONT_APP_CLIENT_SECRET;

if (!shop) fail('No shop: pass --shop or set STOREFRONT_CHAT_ALLOWED_SHOPS.');
if (!secret && !process.argv.includes('--unsigned')) fail('STOREFRONT_APP_CLIENT_SECRET is not set.');

url.searchParams.set('shop', shop);
url.searchParams.set('logged_in_customer_id', '');
url.searchParams.set('path_prefix', '/apps/storefront-advisor');
url.searchParams.set('timestamp', String(Math.floor(Date.now() / 1000)));
if (!process.argv.includes('--unsigned')) url.searchParams.set('signature', signAppProxyQuery(url.searchParams, secret));

const body = {
  sessionId: valueOf('--session') ?? null,
  message: valueOf('--message') ?? 'Bonjour',
  action: valueOf('--action') ?? null,
  choice: valueOf('--choice') ?? null,
  context: { pageType: 'index', productHandle: null, collectionHandle: null, locale: valueOf('--locale') ?? 'fr', path: '/' }
};

const response = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});
console.log(response.status, await response.text());

function valueOf(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

import { readFile } from 'node:fs/promises';

import { loadConfig, loadEnv, parseArgs } from './lib/sync-config.mjs';
import { createSupabaseClient } from './lib/supabase-rest-client.mjs';
import { processComplianceWebhook } from './lib/shopify-compliance-webhooks.mjs';

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const body = await readWebhookBody(args.bodyFile);
  const config = loadConfig(loadEnv());
  const supabase = createSupabaseClient(config);
  const result = await processComplianceWebhook({
    rawBody: body,
    headers: headersFromEnv(process.env),
    config,
    supabase
  });

  if (result.statusCode >= 400) {
    process.exitCode = 1;
  }
  console.log(JSON.stringify(result.body));
}

async function readWebhookBody(path) {
  if (path) {
    return readFile(path);
  }

  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function headersFromEnv(env) {
  return {
    'x-shopify-topic': env.SHOPIFY_WEBHOOK_TOPIC,
    'x-shopify-shop-domain': env.SHOPIFY_WEBHOOK_SHOP_DOMAIN,
    'x-shopify-webhook-id': env.SHOPIFY_WEBHOOK_ID,
    'x-shopify-hmac-sha256': env.SHOPIFY_WEBHOOK_HMAC_SHA256,
    'x-shopify-api-version': env.SHOPIFY_WEBHOOK_API_VERSION,
    'x-shopify-triggered-at': env.SHOPIFY_WEBHOOK_TRIGGERED_AT,
    'x-shopify-event-id': env.SHOPIFY_WEBHOOK_EVENT_ID
  };
}

import { existsSync, readFileSync } from 'node:fs';

export const DEFAULT_API_VERSION = '2026-07';
export const DEFAULT_PAGE_SIZE = 10;

export function parseArgs(argv) {
  const args = {
    dryRun: false,
    limit: null,
    pageSize: DEFAULT_PAGE_SIZE,
    bodyFile: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg.startsWith('--limit=')) {
      args.limit = Number.parseInt(arg.slice('--limit='.length), 10);
    } else if (arg === '--limit') {
      args.limit = Number.parseInt(argv[index + 1], 10);
      index += 1;
    } else if (arg.startsWith('--page-size=')) {
      args.pageSize = Number.parseInt(arg.slice('--page-size='.length), 10);
    } else if (arg === '--page-size') {
      args.pageSize = Number.parseInt(argv[index + 1], 10);
      index += 1;
    } else if (arg.startsWith('--body-file=')) {
      args.bodyFile = arg.slice('--body-file='.length);
    } else if (arg === '--body-file') {
      args.bodyFile = argv[index + 1];
      index += 1;
    }
  }

  if (!Number.isInteger(args.pageSize) || args.pageSize < 1 || args.pageSize > 100) {
    throw new Error('--page-size must be an integer between 1 and 100.');
  }
  if (args.limit !== null && (!Number.isInteger(args.limit) || args.limit < 1)) {
    throw new Error('--limit must be a positive integer.');
  }

  return args;
}

export function loadEnv() {
  const env = { ...process.env };

  for (const file of ['.env.local', '.env']) {
    if (!existsSync(file)) {
      continue;
    }

    const text = readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) {
        continue;
      }

      const [, key, rawValue] = match;
      if (env[key] !== undefined) {
        continue;
      }
      env[key] = stripEnvQuotes(rawValue.trim());
    }
  }

  return env;
}

export function loadConfig(env) {
  const required = [
    'SHOPIFY_STORE_DOMAIN',
    'SUPABASE_URL',
    'SUPABASE_SECRET_KEY'
  ];

  if (!env.SHOPIFY_ADMIN_API_ACCESS_TOKEN && (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET)) {
    required.push('SHOPIFY_ADMIN_API_ACCESS_TOKEN or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET');
  }

  const missing = required.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }

  return {
    shopDomain: env.SHOPIFY_STORE_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, ''),
    shopifyToken: env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
    shopifyClientId: env.SHOPIFY_CLIENT_ID,
    shopifyClientSecret: env.SHOPIFY_CLIENT_SECRET,
    shopifyWebhookSecret: env.SHOPIFY_WEBHOOK_SECRET || env.SHOPIFY_CLIENT_SECRET,
    shopifyApiVersion: env.SHOPIFY_API_VERSION || DEFAULT_API_VERSION,
    shopifyMetaobjectTypes: splitCsv(env.SHOPIFY_METAOBJECT_TYPES),
    knowledgePageMetafieldKeys: splitCsv(env.KNOWLEDGE_PAGE_METAFIELD_KEYS),
    knowledgeManualOverridesPath: env.KNOWLEDGE_MANUAL_OVERRIDES_PATH,
    supabaseUrl: env.SUPABASE_URL.replace(/\/$/, ''),
    supabaseKey: env.SUPABASE_SECRET_KEY,
    // Optional: only needed by the embedding pipeline. The embedding client
    // throws a clear error if openaiApiKey is missing when actually invoked,
    // so callers that never embed (all the Shopify sync scripts) are unaffected.
    openaiApiKey: env.OPENAI_API_KEY,
    embeddingModel: env.EMBEDDING_MODEL || 'text-embedding-3-small',
    embeddingDimensions: Number(env.EMBEDDING_DIMENSIONS) || 1536,
    appEnv: env.APP_ENV || 'development',
    syncCron: env.SYNC_CRON || '0 2 * * *',
    syncTimezone: env.SYNC_TIMEZONE || 'Europe/London'
  };
}

function stripEnvQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function splitCsv(value) {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

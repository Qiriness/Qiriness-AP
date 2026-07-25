import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnv } from '../../scripts/lib/sync-config.mjs';

// Repo root is two levels up from agent/src, so the worker reads the same
// .env.local the sync scripts use regardless of the process working directory.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function loadAgentConfig(env = loadEnv(REPO_ROOT)) {
  const required = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SHOPIFY_STORE_DOMAIN'];
  const missing = required.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }

  return {
    supabaseUrl: env.SUPABASE_URL.replace(/\/$/, ''),
    supabaseKey: env.SUPABASE_SECRET_KEY,
    shopDomain: env.SHOPIFY_STORE_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, ''),
    appEnv: env.APP_ENV || 'development',
    graph: {
      tenantId: env.MS_GRAPH_TENANT_ID,
      clientId: env.MS_GRAPH_CLIENT_ID,
      clientSecret: env.MS_GRAPH_CLIENT_SECRET,
      mailbox: env.SUPPORT_MAILBOX
    },
    pollIntervalMs: Number(env.INGEST_POLL_INTERVAL_MS) || 60000,
    // Draft-only unless explicitly disabled; nothing is auto-sent while true.
    draftOnly: env.DRAFT_ONLY !== 'false',
    // OpenAI (LLM stages). The spam second pass is enabled only when a key is set;
    // without it, ingestion still runs and just skips the LLM filter.
    openaiApiKey: env.OPENAI_API_KEY,
    triageModel: env.AGENT_TRIAGE_MODEL || 'gpt-4o-mini'
  };
}

// Graph credentials are validated separately so the config can be built (and the
// worker started) before they are wired, with a clear error only when ingestion
// actually needs them.
export function assertGraphConfig(config) {
  const { tenantId, clientId, clientSecret, mailbox } = config.graph;
  const missing = Object.entries({
    MS_GRAPH_TENANT_ID: tenantId,
    MS_GRAPH_CLIENT_ID: clientId,
    MS_GRAPH_CLIENT_SECRET: clientSecret,
    SUPPORT_MAILBOX: mailbox
  })
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(
      `Microsoft Graph is not configured. Add to .env.local: ${missing.join(', ')}`
    );
  }
}

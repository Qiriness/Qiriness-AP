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
    // Domains that are ours or operational rather than customers. The support
    // mailbox domain is treated as internal automatically; this covers what it
    // cannot imply (a second corporate domain, a logistics provider). Used by
    // the forwarding pass to avoid handing a colleague their own mail back.
    internalEmailDomains: splitCsv(env.INTERNAL_EMAIL_DOMAINS),
    pollIntervalMs: Number(env.INGEST_POLL_INTERVAL_MS) || 60000,
    // Draft-only unless explicitly disabled; nothing is auto-sent while true.
    draftOnly: env.DRAFT_ONLY !== 'false',
    // OpenAI (LLM stages). The spam second pass is enabled only when a key is set;
    // without it, ingestion still runs and just skips the LLM filter.
    openaiApiKey: env.OPENAI_API_KEY,
    triageModel: env.AGENT_TRIAGE_MODEL || 'gpt-4o-mini',
    // Categoriser: same cheap tier as triage — it picks 1-of-14 plus 1-of-4 with
    // the enums constrained by Structured Outputs, not free reasoning.
    categoriserModel: env.AGENT_CATEGORISER_MODEL || 'gpt-4o-mini',
    // Investigation is the first stage that CHOOSES what to do, so it is the
    // first that needs reliable tool calling rather than a single constrained
    // answer — a mid tier, per the plan's model tiers. The budget below is what
    // keeps that affordable: most tickets resolve in one turn because the
    // deterministic evidence is fetched before the model is asked anything.
    investigatorModel: env.AGENT_INVESTIGATOR_MODEL || 'gpt-4o',
    investigationMaxToolCalls: Number(env.AGENT_INVESTIGATION_MAX_TOOL_CALLS) || 6,
    investigationMaxTurns: Number(env.AGENT_INVESTIGATION_MAX_TURNS) || 4,
    // Must match what the knowledge chunks were embedded with, or cosine
    // comparison between a message and a chunk is meaningless.
    embeddingModel: env.EMBEDDING_MODEL || 'text-embedding-3-small',
    embeddingDimensions: Number(env.EMBEDDING_DIMENSIONS) || 1536
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

function splitCsv(value) {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

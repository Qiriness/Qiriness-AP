/**
 * The model each agent runs on, as chosen in Settings → Agent settings.
 *
 * PRECEDENCE: a row in `agent_models` > the env var (AGENT_*_MODEL, CHAT_MODEL)
 * > the default in agent/src/config.mjs. No row means "whatever the env says",
 * so a database without migration 53, or a shop that never touched the page,
 * runs exactly as before.
 *
 * READ BY BOTH SIDES: the worker reloads the rows every poll and rebuilds its
 * model clients when they change (agent/src/index.mjs); the dashboard applies
 * them to the test chat and the management chat, and writes them.
 *
 * NOT EDITABLE HERE, on purpose:
 * - embeddings: the stored vectors were made with one model, and a query
 *   embedded with another compares against them meaninglessly;
 * - the stages that are off-switched by an empty env var keep that switch in
 *   the env — a row only ever names a model, never "off" (situation,
 *   decompose, casework, closure).
 */

import { supabaseDelete, supabaseSelect, supabaseUpsert } from './supabase-rest-client.mjs';
import { T } from './tables.mjs';

/**
 * Agent id (the `llm_usage.pass` it records under) → the key in
 * `loadAgentConfig()` it overrides. `chat` is the dashboard's CHAT_MODEL and
 * has no worker key. The migration's check constraint lists these same ids.
 */
export const AGENT_MODEL_KEYS = Object.freeze({
  spam: 'triageModel',
  categorise: 'categoriserModel',
  situation: 'situationChooserModel',
  decompose: 'decomposerModel',
  investigate: 'investigatorModel',
  draft: 'draftingModel',
  case_link: 'caseLinkerModel',
  casework: 'caseworkModel',
  closure: 'closureModel',
  chat: null
});

export const EDITABLE_AGENTS = Object.freeze(Object.keys(AGENT_MODEL_KEYS));

// An OpenAI model id: `gpt-4o-mini`, `o3`, `ft:gpt-4o-mini:org::abc`. Letters,
// digits and . _ : - only — it ends up in a request body and a log line.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

export function isValidModelId(model) {
  return typeof model === 'string' && MODEL_ID.test(model);
}

/**
 * Which of an OpenAI `/v1/models` list can drive a chat-completions agent.
 * A blocklist rather than an allowlist so a family released after this was
 * written still shows up.
 */
const NOT_A_CHAT_MODEL = /(embedding|audio|realtime|tts|transcribe|whisper|dall-e|image|moderation|search|instruct|codex|computer-use|babbage|davinci)/i;

export function isChatModelId(model) {
  return /^(gpt-|o\d|chatgpt-)/.test(String(model ?? '')) && !NOT_A_CHAT_MODEL.test(model);
}

/** `{agent: model}` for the shop — only the agents that have a row. */
export async function loadAgentModels(supabase, shopId) {
  const rows = await supabaseSelect(supabase, T.AGENT_MODELS, { shop_id: shopId }, 'agent,model');
  const out = {};
  for (const row of rows ?? []) {
    if (EDITABLE_AGENTS.includes(row.agent) && isValidModelId(row.model)) out[row.agent] = row.model;
  }
  return out;
}

/**
 * Sets one agent's model, or clears it back to the env's with `model = null`.
 * @param {object} supabase
 * @param {{shopId: string, agent: string, model: string | null, updatedBy?: string | null}} choice
 */
export async function saveAgentModel(supabase, { shopId, agent, model, updatedBy = null }) {
  if (!EDITABLE_AGENTS.includes(agent)) throw new Error(`Unknown agent: ${agent}`);
  if (model === null) {
    await supabaseDelete(supabase, T.AGENT_MODELS, { shop_id: shopId, agent });
    return;
  }
  if (!isValidModelId(model)) throw new Error(`Not a model id: ${model}`);
  await supabaseUpsert(
    supabase,
    T.AGENT_MODELS,
    [{ shop_id: shopId, agent, model, updated_by: updatedBy }],
    'shop_id,agent'
  );
}

/**
 * The config with the chosen models applied. Returns the SAME object when
 * nothing applies, so a caller can compare by identity.
 *
 * An empty env value is the documented off switch for the situation chooser
 * and the decomposer; a row does not turn a stage that is off back on.
 */
export function withAgentModels(config, models) {
  let next = config;
  for (const [agent, model] of Object.entries(models ?? {})) {
    const key = AGENT_MODEL_KEYS[agent];
    if (!key || !isValidModelId(model) || config[key] === '' || config[key] === model) continue;
    if (next === config) next = { ...config };
    next[key] = model;
  }
  return next;
}

/** A stable string of every overridable model, to tell whether a rebuild is due. */
export function modelSignature(config) {
  return Object.values(AGENT_MODEL_KEYS)
    .filter(Boolean)
    .map((key) => `${key}=${config?.[key] ?? ''}`)
    .join('|');
}

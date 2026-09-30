/**
 * The OpenAI models this account can call, for the model picker in
 * Settings → Agent settings.
 *
 * READ FROM OPENAI, NOT KEPT IN CODE: new models appear on the account before
 * anyone edits a list here, and a model the key cannot reach should not be
 * offered. Cached for ten minutes; a failed read returns an error and the
 * picker falls back to typing an id.
 *
 * Server-only.
 */

import { isChatModelId } from "../../../scripts/lib/agent-models.mjs";

const MODELS_URL = "https://api.openai.com/v1/models";
const TTL_MS = 10 * 60_000;

export interface OpenAIModelList {
  models: string[];
  error: string | null;
}

let cached: { at: number; models: string[] } | null = null;

export async function listOpenAIModels(): Promise<OpenAIModelList> {
  if (cached && Date.now() - cached.at < TTL_MS) return { models: cached.models, error: null };
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { models: [], error: "OPENAI_API_KEY is not set." };
  try {
    const response = await fetch(MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 401 || response.status === 403) {
      // A restricted key without « Models: Read » (scope api.model.read). It can
      // still call the models it is allowed; it just cannot list them.
      return { models: [], error: "the OpenAI key may not read the model list (missing permission: Models → Read)" };
    }
    if (!response.ok) return { models: [], error: `OpenAI answered ${response.status} for the model list` };
    const payload = (await response.json()) as { data?: { id?: string }[] };
    const models = (payload.data ?? [])
      .map((row) => String(row.id ?? ""))
      .filter((id) => isChatModelId(id))
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    cached = { at: Date.now(), models };
    return { models, error: null };
  } catch (error) {
    return { models: [], error: error instanceof Error ? error.message : "Could not read the model list." };
  }
}

/**
 * Settings → Agent settings: every agent that calls a model, the model it ran
 * on, and what it did over the last 30 days.
 *
 * THE MODEL SHOWN IS THE ONE THAT RAN, NOT THE ONE THIS PROCESS WOULD PICK. The
 * worker reads its own environment on another machine, so `loadAgentConfig()`
 * here only knows the dashboard's copy of AGENT_*_MODEL. `llm_usage` records the
 * model on every call, so the table leads with the most-called model in the
 * window and falls back to the configured one only when the agent did not run.
 *
 * COST IS COMPUTED AT READ TIME, as on the AI agent panel: token counts from
 * `insights_llm_usage`, rates from `llm-rates.mjs`. The management chat keeps its
 * tokens in `chat_turns`, never in `llm_usage`, so it is read separately.
 * Test-chat runs are in neither and are not counted.
 *
 * Server-only.
 */

import { loadAgentConfig } from "../../../agent/src/config.mjs";
import { estimateCost, resolveModelRates } from "../../../scripts/lib/llm-rates.mjs";
import { supabaseSelectAll } from "../../../scripts/lib/supabase-rest-client.mjs";
import { CHAT_T, RPC } from "../../../scripts/lib/tables.mjs";
import { chatModel } from "./chat-service";
import { callRpc, count, getSupabaseClient } from "./insights/shared";
import { getShopId } from "./knowledge-service";

export const AGENT_WINDOW_DAYS = 30;

export interface AgentRosterRow {
  id: string;
  name: string;
  job: string;
  /** The most-called model in the window, else the configured one; null when turned off. */
  model: string | null;
  modelSource: "observed" | "configured" | "off";
  /** Other models seen in the window — a model change mid-window shows here. */
  otherModels: string[];
  envVar: string;
  calls: number;
  failed: number;
  /** Null when any model it ran has no rate in `llm-rates.mjs`. */
  costUsd: number | null;
}

export interface AgentRoster {
  windowDays: number;
  rows: AgentRosterRow[];
  error: string | null;
}

const AGENTS = [
  { id: "spam", name: "Spam filter", job: "Drops spam and irrelevant mail before it becomes a ticket", envVar: "AGENT_TRIAGE_MODEL", configKey: "triageModel" },
  { id: "categorise", name: "Categoriser", job: "Gives each ticket its subject and level", envVar: "AGENT_CATEGORISER_MODEL", configKey: "categoriserModel" },
  { id: "situation", name: "Situation chooser", job: "Picks the situation when the matcher's score is a near miss or a tie", envVar: "AGENT_SITUATION_CHOOSER_MODEL", configKey: "situationChooserModel" },
  { id: "decompose", name: "Decomposer", job: "Splits an email into its separate requests", envVar: "AGENT_DECOMPOSER_MODEL", configKey: "decomposerModel" },
  { id: "investigate", name: "Investigator", job: "Gathers the facts a reply needs, using tools", envVar: "AGENT_INVESTIGATOR_MODEL", configKey: "investigatorModel" },
  { id: "draft", name: "Drafting", job: "Writes the reply a person reviews", envVar: "AGENT_DRAFTING_MODEL", configKey: "draftingModel" },
  { id: "embed", name: "Embeddings", job: "Turns mail and articles into vectors for search", envVar: "EMBEDDING_MODEL", configKey: "embeddingModel" },
] as const;

interface Tally {
  calls: number;
  failed: number;
  cost: number;
  unpriced: boolean;
  byModel: Map<string, number>;
}

const emptyTally = (): Tally => ({ calls: 0, failed: 0, cost: 0, unpriced: false, byModel: new Map() });

export async function getAgentRoster(): Promise<AgentRoster> {
  const to = new Date();
  const from = new Date(to.getTime() - AGENT_WINDOW_DAYS * 86_400_000);

  let config: Record<string, unknown> = {};
  try {
    config = loadAgentConfig(process.env) as Record<string, unknown>;
  } catch {
    // Without the worker's env the configured column falls back to "—"; the
    // observed models and figures do not depend on it.
  }

  try {
    const rates = resolveModelRates(process.env);
    const [usageRows, chatRows] = await Promise.all([
      getShopId().then((shopId) =>
        callRpc<Record<string, unknown>>(RPC.INSIGHTS_LLM_USAGE, {
          p_shop: shopId,
          p_from: from.toISOString().slice(0, 19),
          p_to: to.toISOString().slice(0, 19),
          p_tz: "UTC",
        })
      ),
      supabaseSelectAll(
        getSupabaseClient(),
        CHAT_T.TURNS,
        { created_at: { operator: "gte", value: from.toISOString() } },
        "id,model,status,input_tokens,cached_input_tokens,output_tokens"
      ) as Promise<Record<string, unknown>[]>,
    ]);

    const byPass = new Map<string, Tally>();
    for (const row of usageRows) {
      const pass = String(row.pass ?? "other");
      const model = String(row.model ?? "unknown");
      const calls = count(row.calls);
      const tally = byPass.get(pass) ?? emptyTally();
      tally.calls += calls;
      tally.failed += count(row.failed_calls);
      tally.byModel.set(model, (tally.byModel.get(model) ?? 0) + calls);
      const cost = estimateCost({ model, inputTokens: count(row.input_tokens), outputTokens: count(row.output_tokens), rates });
      if (cost.rated) tally.cost += cost.totalUsd;
      else tally.unpriced = true;
      byPass.set(pass, tally);
    }

    const chat = emptyTally();
    for (const row of chatRows) {
      const model = String(row.model ?? "unknown");
      chat.calls += 1;
      if (row.status === "error") chat.failed += 1;
      chat.byModel.set(model, (chat.byModel.get(model) ?? 0) + 1);
      const cost = estimateCost({
        model,
        inputTokens: count(row.input_tokens),
        cachedInputTokens: count(row.cached_input_tokens),
        outputTokens: count(row.output_tokens),
        rates,
      });
      if (cost.rated) chat.cost += cost.totalUsd;
      else chat.unpriced = true;
    }

    const rows = AGENTS.map((agent) => {
      const configured = config[agent.configKey];
      return toRow(agent, byPass.get(agent.id) ?? emptyTally(), typeof configured === "string" ? configured : undefined);
    });
    rows.push(
      toRow(
        { id: "chat", name: "Management chat", job: "Answers questions about the shop on Home", envVar: "CHAT_MODEL" },
        chat,
        chatModel()
      )
    );
    const other = byPass.get("other");
    if (other && other.calls > 0) {
      rows.push(toRow({ id: "other", name: "Other", job: "Calls recorded without a known agent", envVar: "—" }, other, undefined));
    }

    return { windowDays: AGENT_WINDOW_DAYS, rows, error: null };
  } catch (error) {
    return {
      windowDays: AGENT_WINDOW_DAYS,
      rows: [],
      error: error instanceof Error ? error.message : "Could not load the agents.",
    };
  }
}

function toRow(
  agent: { id: string; name: string; job: string; envVar: string },
  tally: Tally,
  configured: string | undefined
): AgentRosterRow {
  const ranked = [...tally.byModel.entries()].sort((a, b) => b[1] - a[1]).map(([model]) => model);
  // An empty AGENT_DECOMPOSER_MODEL or AGENT_SITUATION_CHOOSER_MODEL is the documented off switch.
  const off = configured === "" && ranked.length === 0;
  return {
    id: agent.id,
    name: agent.name,
    job: agent.job,
    model: ranked[0] ?? (configured || null),
    modelSource: ranked.length > 0 ? "observed" : off ? "off" : "configured",
    otherModels: ranked.slice(1),
    envVar: agent.envVar,
    calls: tally.calls,
    failed: tally.failed,
    costUsd: tally.unpriced ? null : tally.cost,
  };
}

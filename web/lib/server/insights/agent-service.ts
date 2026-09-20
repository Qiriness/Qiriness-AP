/**
 * The AI agent panel's reads over the range in the URL: what it cost, how far
 * tickets get, and what stops them.
 *
 * COST IS COMPUTED HERE, NEVER STORED. `llm_usage` holds token counts; the rate
 * lives in `scripts/lib/llm-rates.mjs` and is applied at read time, per model,
 * so a changed rate card restates history rather than invalidating it.
 *
 * Server-only; see ./shared.ts for why nothing here pages rows.
 */

import { RPC } from "../../../../scripts/lib/tables.mjs";
import { estimateCost, resolveModelRates } from "../../../../scripts/lib/llm-rates.mjs";
import type {
  AgentPanel,
  EvidenceGapRow,
  InvestigationVerdict,
  PipelineFunnel,
  SituationPicking,
  UsageSummary,
  VerdictRow,
} from "../../types";
import { rangeArgs, type InsightsContext } from "./context";
import { toSeries } from "./series";
import { callRpc, callRpcOne, count, num } from "./shared";

/**
 * `satisfied` means the agent GOT the fact: the gaps array is the whole ledger
 * of what a ticket required, not a list of failures.
 */
const SATISFIED = "satisfied";

/** Readable names for the needs worth naming; anything else is title-cased from its slug. */
const NEED_LABELS: Record<string, string> = {
  order_identity: "Which order is this",
  order_state: "Where the order stands",
  delivery_state: "Where the parcel is",
  delivery_delay_state: "Whether delivery is running late",
  promotion_identity: "Which promotion is this",
  promotion_validity: "Whether the code is live",
  promotion_eligibility: "Whether this order qualifies",
  product_identity: "Which product is this",
  product_property: "A fact about the product",
  product_availability: "Whether it is in stock",
  customer_identity: "Who is writing",
  customer_account_state: "The state of their account",
  return_eligibility: "Whether a return is still possible",
  policy_answer: "What an approved policy says",
  checkout_state: "What was in the abandoned basket",
  other_fact: "Something else the reply needed",
};

export async function getAgentPanel(ctx: InsightsContext): Promise<AgentPanel> {
  const rates = resolveModelRates(process.env);
  const args = rangeArgs(ctx);
  const previousArgs = rangeArgs(ctx, ctx.range.previous);

  const [usageNow, usageBefore, statsNow, statsBefore, seriesRows, funnelRow, verdictRows, gapRows, situationRow] =
    await Promise.all([
      callRpc<Record<string, unknown>>(RPC.INSIGHTS_LLM_USAGE, args),
      callRpc<Record<string, unknown>>(RPC.INSIGHTS_LLM_USAGE, previousArgs),
      callRpcOne<Record<string, unknown>>(RPC.INSIGHTS_LLM_TICKET_STATS, args),
      callRpcOne<Record<string, unknown>>(RPC.INSIGHTS_LLM_TICKET_STATS, previousArgs),
      callRpc<Record<string, unknown>>(RPC.INSIGHTS_LLM_SERIES, { ...args, p_grain: ctx.range.grain }),
      callRpcOne<Record<string, unknown>>(RPC.INSIGHTS_AGENT_FUNNEL, args),
      callRpc<Record<string, unknown>>(RPC.INSIGHTS_AGENT_VERDICTS, args),
      callRpc<Record<string, unknown>>(RPC.INSIGHTS_AGENT_BLOCKERS, args),
      callRpcOne<Record<string, unknown>>(RPC.INSIGHTS_AGENT_SITUATIONS, args),
    ]);

  // Spend per bucket: each (bucket, model) row priced at its own model's rate,
  // then summed — a mixed-model token total times any one rate means nothing.
  const spendByBucket = new Map<string, { bucket: string; usd: number; unpriced: boolean }>();
  for (const row of seriesRows) {
    const bucket = String(row.bucket);
    const cost = estimateCost({
      model: String(row.model ?? "unknown"),
      inputTokens: count(row.input_tokens),
      outputTokens: count(row.output_tokens),
      rates,
    });
    const entry = spendByBucket.get(bucket) ?? { bucket, usd: 0, unpriced: false };
    if (cost.rated) entry.usd += cost.totalUsd;
    else entry.unpriced = true;
    spendByBucket.set(bucket, entry);
  }

  const verdicts = verdictRows.map(mapVerdict);
  const previousHasCalls = usageBefore.length > 0;

  return {
    usage: {
      current: summarise(usageNow, statsNow, rates),
      // No calls at all in the previous period means capture had not started
      // (or the agent was idle), not that it was free; there is no change to show.
      previous: previousHasCalls ? summarise(usageBefore, statsBefore, rates) : null,
    },
    spend: toSeries(
      ctx.range,
      [...spendByBucket.values()],
      (row) => (row ? row.usd : 0),
      { from: null, through: null }
    ),
    funnel: mapFunnel(funnelRow ?? {}),
    situations: mapSituations(situationRow ?? {}),
    verdicts,
    automationCeiling: automationCeiling(verdicts),
    blockers: rankBlockers(gapRows),
  };
}

function summarise(
  rows: Record<string, unknown>[],
  stats: Record<string, unknown> | null,
  rates: ReturnType<typeof resolveModelRates>
): UsageSummary {
  const byModel = new Map<string, { model: string; calls: number; totalTokens: number; costUsd: number | null }>();
  let costUsd = 0;
  let hasUnpricedModels = false;

  for (const row of rows) {
    const model = String(row.model ?? "unknown");
    const cost = estimateCost({
      model,
      inputTokens: count(row.input_tokens),
      outputTokens: count(row.output_tokens),
      rates,
    });
    const entry = byModel.get(model) ?? { model, calls: 0, totalTokens: 0, costUsd: 0 };
    entry.calls += count(row.calls);
    entry.totalTokens += count(row.total_tokens);
    if (cost.rated && entry.costUsd !== null) entry.costUsd += cost.totalUsd;
    if (!cost.rated) {
      entry.costUsd = null;
      hasUnpricedModels = true;
    } else costUsd += cost.totalUsd;
    byModel.set(model, entry);
  }

  return {
    calls: rows.reduce((sum, row) => sum + count(row.calls), 0),
    totalTokens: rows.reduce((sum, row) => sum + count(row.total_tokens), 0),
    failedCalls: rows.reduce((sum, row) => sum + count(row.failed_calls), 0),
    costUsd: rows.length === 0 ? 0 : costUsd,
    hasUnpricedModels,
    ticketsTouched: count(stats?.tickets_touched),
    meanTokensPerTicket: num(stats?.mean_tokens_per_ticket),
    maxTokensOnATicket: num(stats?.max_tokens_on_a_ticket),
    byModel: [...byModel.values()].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0)),
  };
}

/** The share of case files the agent could have answered unaided — the honest automation ceiling. */
export function automationCeiling(verdicts: VerdictRow[]): number | null {
  const total = verdicts.reduce((sum, v) => sum + v.investigations, 0);
  if (!total) return null;
  return (verdicts.find((v) => v.verdict === "answerable")?.investigations ?? 0) / total;
}

/** Unmet needs only, ranked by how many tickets they held up. */
export function rankBlockers(rows: Record<string, unknown>[]): EvidenceGapRow[] {
  return rows
    .filter((row) => String(row.state ?? "") !== SATISFIED)
    .map((row) => {
      const need = String(row.need ?? "unknown");
      return {
        need,
        label: NEED_LABELS[need] ?? titleCase(need),
        state: (row.state as string) ?? null,
        finding: (row.finding as string) ?? null,
        occurrences: count(row.occurrences),
        tickets: count(row.tickets),
      };
    })
    .sort((a, b) => b.tickets - a.tickets || b.occurrences - a.occurrences);
}

function titleCase(slug: string): string {
  const words = slug.split("_").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function mapFunnel(row: Record<string, unknown>): PipelineFunnel {
  return {
    tickets: count(row.tickets),
    categorised: count(row.categorised),
    customerLinked: count(row.customer_linked),
    orderLinked: count(row.order_linked),
    contextBuilt: count(row.context_built),
    investigated: count(row.investigated),
    lowConfidence: count(row.low_confidence),
    awaitingCategorisation: count(row.awaiting_categorisation),
    awaitingInvestigation: count(row.awaiting_investigation),
  };
}

function mapSituations(row: Record<string, unknown>): SituationPicking {
  return {
    tickets: count(row.tickets),
    matched: count(row.matched),
    tieByRules: count(row.tie_by_rules),
    chosenByModel: count(row.chosen_by_model),
    nearChooserNone: count(row.near_chooser_none),
    nearNotSettled: count(row.near_not_settled),
    noMatch: count(row.no_match),
    notRecorded: count(row.not_recorded),
  };
}

function mapVerdict(row: Record<string, unknown>): VerdictRow {
  return {
    verdict: row.verdict as InvestigationVerdict,
    investigations: count(row.investigations),
    tickets: count(row.tickets),
    withHandoff: count(row.with_handoff),
  };
}

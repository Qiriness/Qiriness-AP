/**
 * The Agent panel's reads: how far tickets get, what stops them, and what it
 * all costs.
 *
 * THE EVIDENCE-GAP LEADERBOARD IS THE POINT OF THIS PANEL. It is the agent
 * reporting its own blockers, so a ranked list of unmet needs is a prioritised
 * build list rather than an opinion — and it is generated rather than curated,
 * so it cannot go stale the way a roadmap does.
 *
 * COST IS COMPUTED HERE, NEVER STORED. `llm_usage` holds token counts; the rate
 * lives in `scripts/lib/llm-rates.mjs` and is applied at read time. A euro
 * figure written into a row would be wrong the day the rate card moved, with no
 * way to restate the history behind it.
 *
 * Server-only; see ./shared.ts for why nothing here reduces table-sized reads.
 */

import { V } from "../../../../scripts/lib/tables.mjs";
import { estimateCost, resolveModelRates } from "../../../../scripts/lib/llm-rates.mjs";
import type {
  AgentPanel,
  EvidenceGapRow,
  InvestigationVerdict,
  PipelineFunnel,
  UsageMonth,
  UsageSummary,
  VerdictRow,
} from "../../types";
import { count, num, readOne, readView } from "./shared";

/**
 * `state` on an evidence gap is what happened to the need, and only two of the
 * three values are blockers.
 *
 * `satisfied` means the agent GOT the fact — it appears in the gaps array
 * because the array is the whole ledger of what a ticket required, not a list
 * of failures. Ranking without this filter puts "customer_identity: resolved"
 * near the top of a chart headed "what is blocking us", which is precisely
 * backwards.
 */
const SATISFIED = "satisfied";

/**
 * Readable names for the needs worth naming. Anything absent is title-cased
 * from its slug, so a need added to `evidence-rules.mjs` shows up legibly here
 * without a second registry to keep in sync.
 */
const NEED_LABELS: Record<string, string> = {
  order_identity: "Which order is this",
  order_state: "Where the order stands",
  delivery_state: "Where the parcel is",
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

export async function getAgentPanel(shopId: string): Promise<AgentPanel> {
  const [funnelRow, gapRows, verdictRows, usageRow, usageMonthRows] = await Promise.all([
    readOne<Record<string, unknown>>(V.AGENT_PIPELINE_FUNNEL, shopId),
    readView<Record<string, unknown>>(V.INVESTIGATION_EVIDENCE_GAPS, shopId, {
      order: "occurrences.desc",
    }),
    readView<Record<string, unknown>>(V.INVESTIGATION_VERDICTS, shopId, {
      order: "investigations.desc",
    }),
    readOne<Record<string, unknown>>(V.LLM_USAGE_SUMMARY, shopId),
    readView<Record<string, unknown>>(V.LLM_USAGE_BY_MONTH, shopId, { order: "month.asc" }),
  ]);

  const verdicts = verdictRows.map(mapVerdict);
  const usageByMonth = mapUsageMonths(usageMonthRows);

  return {
    funnel: funnelRow ? mapFunnel(funnelRow) : null,
    blockers: rankBlockers(gapRows),
    verdicts,
    automationCeiling: automationCeiling(verdicts),
    usage: usageRow ? mapUsage(usageRow, usageByMonth) : null,
    usageByMonth,
    // Nothing has been recorded until the worker runs with the sink wired, and
    // an empty cost section has to say "not recorded yet" rather than "$0.00".
    hasUsageData: usageByMonth.length > 0,
  };
}

/**
 * The share of case files the agent could have answered unaided.
 *
 * The honest automation ceiling, and a better weekly number than any accuracy
 * score: accuracy asks whether the labels were right, this asks whether the
 * work could have been finished.
 */
export function automationCeiling(verdicts: VerdictRow[]): number | null {
  const total = verdicts.reduce((sum, v) => sum + v.investigations, 0);
  if (!total) return null;
  const answerable = verdicts.find((v) => v.verdict === "answerable")?.investigations ?? 0;
  return answerable / total;
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

function mapVerdict(row: Record<string, unknown>): VerdictRow {
  return {
    verdict: row.verdict as InvestigationVerdict,
    investigations: count(row.investigations),
    tickets: count(row.tickets),
    withHandoff: count(row.with_handoff),
  };
}

/**
 * Rates are resolved once per render rather than per row: `resolveModelRates`
 * parses an env var, and doing that inside a map would parse it once per month
 * per model for no benefit.
 */
function mapUsageMonths(rows: Record<string, unknown>[]): UsageMonth[] {
  const rates = resolveModelRates(process.env);

  return rows.map((row) => {
    const inputTokens = count(row.input_tokens);
    const outputTokens = count(row.output_tokens);
    const model = String(row.model ?? "unknown");
    const cost = estimateCost({ model, inputTokens, outputTokens, rates });

    return {
      month: String(row.month),
      model,
      pass: String(row.pass ?? "other"),
      calls: count(row.calls),
      inputTokens,
      outputTokens,
      totalTokens: count(row.total_tokens),
      failedCalls: count(row.failed_calls),
      // Null rather than 0 for an unpriced model: a new model reporting €0.00
      // because nobody added its rate is worse than one that says it does not
      // know. See `rated` in llm-rates.mjs.
      costUsd: cost.rated ? cost.totalUsd : null,
    };
  });
}

/**
 * The cost tiles.
 *
 * Money is summed from the per-model monthly rows, NOT from the summary's
 * totals: the summary aggregates tokens across every model at once, and
 * multiplying a mixed-model token total by any single rate would be meaningless.
 */
function mapUsage(row: Record<string, unknown>, byMonth: UsageMonth[]): UsageSummary {
  const priced = byMonth.filter((m) => m.costUsd !== null);
  const hasUnpricedModels = byMonth.some((m) => m.costUsd === null);
  const costUsd = byMonth.length === 0 ? null : priced.reduce((sum, m) => sum + (m.costUsd ?? 0), 0);

  const thisMonth = new Date().toISOString().slice(0, 7);
  const mtd = byMonth.filter((m) => m.month.slice(0, 7) === thisMonth);

  return {
    totalTokens: count(row.total_tokens),
    inputTokens: count(row.input_tokens),
    outputTokens: count(row.output_tokens),
    calls: count(row.calls),
    ticketsTouched: count(row.tickets_touched),
    meanTokensPerTicket: num(row.mean_tokens_per_ticket),
    maxTokensOnATicket: num(row.max_tokens_on_a_ticket),
    firstRecordedAt: (row.first_recorded_at as string) ?? null,
    lastRecordedAt: (row.last_recorded_at as string) ?? null,
    costUsd,
    hasUnpricedModels,
    monthToDateUsd: mtd.length === 0 ? null : mtd.reduce((sum, m) => sum + (m.costUsd ?? 0), 0),
    monthToDateTokens: mtd.reduce((sum, m) => sum + m.totalTokens, 0),
  };
}

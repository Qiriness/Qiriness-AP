import type { AgentPanel, PipelineFunnel } from "@/lib/types";
import { BarList, Card, DeltaChip, EmptyState, Grid, KpiCard, compactNumber, percent, usd } from "./InsightsKit";
import { SplitBar } from "./SplitBar";
import { TimeSeriesChart } from "./TimeSeriesChart";
import { perGrain } from "./grain";

const VERDICT_LABELS: Record<string, string> = {
  answerable: "Answerable unaided",
  needs_customer_input: "Needs the customer",
  needs_human: "Needs a human",
};

/** Fixed per verdict, never by rank, so a range with one verdict missing does not repaint the rest. */
const VERDICT_COLORS: Record<string, string> = {
  answerable: "var(--chart-1)",
  needs_customer_input: "var(--chart-2)",
  needs_human: "var(--chart-3)",
};

const MODEL_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"];

function funnelStages(f: PipelineFunnel) {
  return [
    { key: "tickets", label: "Arrived", value: f.tickets },
    { key: "categorised", label: "Categorised", value: f.categorised },
    { key: "customer", label: "Customer linked", value: f.customerLinked },
    { key: "order", label: "Order linked", value: f.orderLinked },
    { key: "context", label: "Context built", value: f.contextBuilt },
    { key: "investigated", label: "Investigated", value: f.investigated },
  ];
}

/** The AI agent over the chosen range: spend first, then how far it gets and what stops it. */
export function AgentView({ panel, compareLabel }: { panel: AgentPanel; compareLabel: string }) {
  const { current, previous } = panel.usage;
  const grain = perGrain(panel.spend);
  const costPerTicket =
    current.costUsd !== null && current.ticketsTouched > 0 ? current.costUsd / current.ticketsTouched : null;
  const previousPerTicket =
    previous && previous.costUsd !== null && previous.ticketsTouched > 0
      ? previous.costUsd / previous.ticketsTouched
      : null;
  const investigations = panel.verdicts.reduce((sum, v) => sum + v.investigations, 0);
  const { funnel } = panel;

  return (
    <>
      <Grid pin="headline" label="AI agent headline figures">
        <KpiCard
          label="AI spend"
          value={usd(current.costUsd)}
          delta={<DeltaChip current={current.costUsd} previous={previous?.costUsd} polarity="down" compareLabel={compareLabel} />}
          sub={[
            { label: "Model calls", value: current.calls.toLocaleString("en-GB") },
            { label: "Tokens", value: compactNumber(current.totalTokens) },
          ]}
        />
        <KpiCard
          label="Cost per ticket"
          value={usd(costPerTicket)}
          delta={<DeltaChip current={costPerTicket} previous={previousPerTicket} polarity="down" compareLabel={compareLabel} />}
          sub={[
            { label: "Tickets worked", value: current.ticketsTouched.toLocaleString("en-GB") },
            {
              label: "Worst ticket",
              value: current.maxTokensOnATicket === null ? "—" : `${compactNumber(current.maxTokensOnATicket)} tokens`,
            },
          ]}
        />
        <KpiCard
          label="Answerable unaided"
          value={panel.automationCeiling === null ? "—" : `${(panel.automationCeiling * 100).toFixed(0)}%`}
          sub={[{ label: "Case files", value: investigations.toLocaleString("en-GB") }]}
        />
        <KpiCard
          label="Linked to an order"
          value={percent(funnel.orderLinked, funnel.tickets, 0)}
          tone={funnel.tickets > 0 && funnel.orderLinked / funnel.tickets < 0.5 ? "warn" : undefined}
          sub={[
            { label: "Tickets", value: funnel.tickets.toLocaleString("en-GB") },
            { label: "Awaiting investigation", value: funnel.awaitingInvestigation.toLocaleString("en-GB") },
          ]}
        />
      </Grid>

      <Grid min={100} pin="spend-chart" label="AI spend chart">
        <Card
          title={`AI spend ${grain}`}
          aside={current.hasUnpricedModels ? <span>Some models have no configured rate — spend is a floor</span> : null}
        >
          <TimeSeriesChart points={panel.spend} unit="usd" ariaLabel={`AI spend ${grain}`} />
        </Card>
      </Grid>

      <Grid min={22} pin="pipeline" label="Pipeline, verdicts and spend by model">
        <Card title="How far tickets get">
          {funnel.tickets === 0 ? (
            <EmptyState>No ticket was first written in this range.</EmptyState>
          ) : (
            <BarList
              ariaLabel="Tickets reaching each pipeline stage"
              data={funnelStages(funnel).map((s) => ({
                key: s.key,
                label: s.label,
                value: s.value,
                display: `${s.value.toLocaleString("en-GB")}  ·  ${percent(s.value, funnel.tickets, 0)}`,
                emphasis: s.key === "order" && s.value / Math.max(1, funnel.tickets) < 0.5,
              }))}
            />
          )}
        </Card>
        <Card title="What the investigation concluded">
          {investigations === 0 ? (
            <EmptyState>No investigation ran in this range.</EmptyState>
          ) : (
            <SplitBar
              total={investigations}
              parts={panel.verdicts.map((v) => ({
                key: v.verdict,
                label: VERDICT_LABELS[v.verdict] ?? v.verdict,
                value: v.investigations,
                color: VERDICT_COLORS[v.verdict] ?? "var(--chart-4)",
              }))}
            />
          )}
        </Card>
        <Card title="Spend by model">
          {current.byModel.length === 0 ? (
            <EmptyState>No model calls in this range.</EmptyState>
          ) : (
            <SplitBar
              total={current.byModel.reduce((sum, m) => sum + (m.costUsd ?? 0), 0)}
              parts={current.byModel.slice(0, 4).map((m, i) => ({
                key: m.model,
                label: m.model,
                value: m.costUsd ?? 0,
                color: MODEL_COLORS[i],
                display: usd(m.costUsd),
              }))}
            />
          )}
        </Card>
      </Grid>

      <Grid min={100} pin="blockers" label="What is blocking the most tickets">
        <Card title="What is blocking the most tickets">
          {panel.blockers.length === 0 ? (
            <EmptyState>No unmet evidence need in this range.</EmptyState>
          ) : (
            <BarList
              ariaLabel="Unmet evidence needs, by tickets held up"
              data={panel.blockers.slice(0, 10).map((b) => ({
                key: `${b.need}-${b.state}-${b.finding}`,
                label: b.label,
                value: b.tickets,
                display: `${b.tickets} ticket${b.tickets === 1 ? "" : "s"}`,
                title: `${b.need} (${b.state ?? "unknown state"}${b.finding ? `, found: ${b.finding}` : ""})`,
              }))}
            />
          )}
        </Card>
      </Grid>
    </>
  );
}

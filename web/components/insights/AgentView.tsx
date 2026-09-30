import type { AgentPanel, PipelineFunnel, SituationPicking } from "@/lib/types";
import { getFormat, getT } from "@/lib/i18n/server";
import type { Translate } from "@/lib/i18n/translate";
import { BarList, Card, DeltaChip, EmptyState, Grid, KpiCard } from "./InsightsKit";
import { SplitBar } from "./SplitBar";
import { TimeSeriesChart } from "./TimeSeriesChart";
import { perGrain } from "./grain";

// Verdict words: `insights.agent.verdict.<key>`.

/** Fixed per verdict, never by rank, so a range with one verdict missing does not repaint the rest. */
const VERDICT_COLORS: Record<string, string> = {
  answerable: "var(--chart-1)",
  needs_customer_input: "var(--chart-2)",
  needs_human: "var(--chart-3)",
};

const MODEL_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"];

function funnelStages(f: PipelineFunnel, t: Translate) {
  return [
    { key: "tickets", label: t("insights.agent.stage.arrived"), value: f.tickets },
    { key: "categorised", label: t("insights.agent.stage.categorised"), value: f.categorised },
    { key: "customer", label: t("insights.agent.stage.customer"), value: f.customerLinked },
    { key: "order", label: t("insights.agent.stage.order"), value: f.orderLinked },
    { key: "context", label: t("insights.agent.stage.context"), value: f.contextBuilt },
    { key: "investigated", label: t("insights.agent.stage.investigated"), value: f.investigated },
  ];
}

/**
 * How a situation was picked, one bar per outcome. The first three got a
 * situation; the rest did not. Rarer outcomes are drawn only when they happened,
 * so an empty bucket does not read as a stage the pipeline has.
 */
function situationStages(s: SituationPicking, t: Translate) {
  return [
    { key: "matched", label: t("insights.agent.sit.matched"), value: s.matched, always: true },
    { key: "rules", label: t("insights.agent.sit.rules"), value: s.tieByRules, always: false },
    { key: "model", label: t("insights.agent.sit.model"), value: s.chosenByModel, always: true },
    { key: "none", label: t("insights.agent.sit.none"), value: s.nearChooserNone, always: true },
    { key: "unsettled", label: t("insights.agent.sit.unsettled"), value: s.nearNotSettled, always: true },
    { key: "no-match", label: t("insights.agent.sit.noMatch"), value: s.noMatch, always: true },
    { key: "unrecorded", label: t("insights.agent.sit.unrecorded"), value: s.notRecorded, always: false },
  ].filter((stage) => stage.always || stage.value > 0);
}

/** The AI agent over the chosen range: spend first, then how far it gets and what stops it. */
export function AgentView({ panel, compareLabel }: { panel: AgentPanel; compareLabel: string }) {
  const t = getT();
  const { compactNumber, integer, percent, percentOf, usd } = getFormat();
  const { current, previous } = panel.usage;
  const grain = t(`insights.sales.per.${perGrain(panel.spend)}`);
  const costPerTicket =
    current.costUsd !== null && current.ticketsTouched > 0 ? current.costUsd / current.ticketsTouched : null;
  const previousPerTicket =
    previous && previous.costUsd !== null && previous.ticketsTouched > 0
      ? previous.costUsd / previous.ticketsTouched
      : null;
  const investigations = panel.verdicts.reduce((sum, v) => sum + v.investigations, 0);
  const { funnel, situations } = panel;
  const withSituation = situations.matched + situations.tieByRules + situations.chosenByModel;

  return (
    <>
      <Grid pin="headline" label={t("insights.agent.headline")}>
        <KpiCard
          label={t("insights.agent.spend")}
          value={usd(current.costUsd)}
          delta={<DeltaChip current={current.costUsd} previous={previous?.costUsd} polarity="down" compareLabel={compareLabel} />}
          sub={[
            { label: t("insights.agent.calls"), value: integer(current.calls) },
            { label: t("insights.agent.tokens"), value: compactNumber(current.totalTokens) },
          ]}
        />
        <KpiCard
          label={t("insights.agent.costPerTicket")}
          value={usd(costPerTicket)}
          delta={<DeltaChip current={costPerTicket} previous={previousPerTicket} polarity="down" compareLabel={compareLabel} />}
          sub={[
            { label: t("insights.agent.worked"), value: integer(current.ticketsTouched) },
            {
              label: t("insights.agent.worst"),
              value: current.maxTokensOnATicket === null ? "—" : t("insights.agent.tokensN", { n: compactNumber(current.maxTokensOnATicket) }),
            },
          ]}
        />
        <KpiCard
          label={t("insights.agent.verdict.answerable")}
          value={panel.automationCeiling === null ? "—" : percentOf(panel.automationCeiling * 100, 0)}
          sub={[{ label: t("insights.agent.caseFiles"), value: integer(investigations) }]}
        />
        <KpiCard
          label={t("insights.agent.linkedOrder")}
          value={percent(funnel.orderLinked, funnel.tickets, 0)}
          tone={funnel.tickets > 0 && funnel.orderLinked / funnel.tickets < 0.5 ? "warn" : undefined}
          sub={[
            { label: t("insights.support.tickets"), value: integer(funnel.tickets) },
            { label: t("insights.agent.awaiting"), value: integer(funnel.awaitingInvestigation) },
          ]}
        />
      </Grid>

      <Grid min={100} pin="spend-chart" label={t("insights.agent.spendChart")}>
        <Card
          title={t("insights.agent.spendPer", { grain })}
          aside={current.hasUnpricedModels ? <span>{t("insights.agent.unpriced")}</span> : null}
        >
          <TimeSeriesChart points={panel.spend} unit="usd" ariaLabel={t("insights.agent.spendPer", { grain })} />
        </Card>
      </Grid>

      <Grid min={22} pin="pipeline" label={t("insights.agent.pipelineRow")}>
        <Card title={t("insights.agent.howFar")}>
          {funnel.tickets === 0 ? (
            <EmptyState>{t("insights.agent.noneWritten")}</EmptyState>
          ) : (
            <BarList
              ariaLabel={t("insights.agent.stagesAria")}
              data={funnelStages(funnel, t).map((s) => ({
                key: s.key,
                label: s.label,
                value: s.value,
                display: `${integer(s.value)}  ·  ${percent(s.value, funnel.tickets, 0)}`,
                emphasis: s.key === "order" && s.value / Math.max(1, funnel.tickets) < 0.5,
              }))}
            />
          )}
        </Card>
        <Card
          title={t("insights.agent.howPicked")}
          aside={
            situations.tickets > 0 ? (
              <span>
                {t("insights.agent.gotOne", { pct: percent(withSituation, situations.tickets, 0) })}
              </span>
            ) : null
          }
        >
          {situations.tickets === 0 ? (
            <EmptyState>{t("insights.agent.noInvestigation")}</EmptyState>
          ) : (
            <BarList
              ariaLabel={t("insights.agent.situationsAria")}
              data={situationStages(situations, t).map((s) => ({
                key: s.key,
                label: s.label,
                value: s.value,
                display: `${integer(s.value)}  ·  ${percent(s.value, situations.tickets, 0)}`,
                emphasis: s.key === "unsettled" && s.value > 0,
              }))}
            />
          )}
        </Card>
        <Card title={t("insights.agent.concluded")}>
          {investigations === 0 ? (
            <EmptyState>{t("insights.agent.noInvestigation")}</EmptyState>
          ) : (
            <SplitBar
              total={investigations}
              parts={panel.verdicts.map((v) => ({
                key: v.verdict,
                label: ["answerable", "needs_customer_input", "needs_human"].includes(v.verdict) ? t(`insights.agent.verdict.${v.verdict}`) : v.verdict,
                value: v.investigations,
                color: VERDICT_COLORS[v.verdict] ?? "var(--chart-4)",
              }))}
            />
          )}
        </Card>
        <Card title={t("insights.agent.byModel")}>
          {current.byModel.length === 0 ? (
            <EmptyState>{t("insights.agent.noCalls")}</EmptyState>
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

      <Grid min={100} pin="blockers" label={t("insights.agent.blocking")}>
        <Card title={t("insights.agent.blocking")}>
          {panel.blockers.length === 0 ? (
            <EmptyState>{t("insights.agent.noBlockers")}</EmptyState>
          ) : (
            <BarList
              ariaLabel={t("insights.agent.blockersAria")}
              data={panel.blockers.slice(0, 10).map((b) => ({
                key: `${b.need}-${b.state}-${b.finding}`,
                label: t(`need.${b.need}`) === `need.${b.need}` ? b.label : t(`need.${b.need}`),
                value: b.tickets,
                display: t("insights.agent.ticketsN", { count: b.tickets }),
                title: `${b.need} (${b.state ?? t("insights.agent.unknownState")}${b.finding ? `, ${t("insights.agent.found", { finding: b.finding })}` : ""})`,
              }))}
            />
          )}
        </Card>
      </Grid>
    </>
  );
}

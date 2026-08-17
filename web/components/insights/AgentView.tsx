import type { AgentPanel, PipelineFunnel } from "@/lib/types";
import {
  BarList,
  BlockedTile,
  EmptyState,
  Note,
  PanelSection,
  StatTile,
  TileGrid,
  compactNumber,
  percent,
  usd,
} from "./InsightsKit";
import { formatMonth } from "@/lib/insights-format";
import styles from "./AgentView.module.css";

const VERDICT_LABELS: Record<string, string> = {
  answerable: "Answerable unaided",
  needs_human: "Needs a human",
  needs_customer_input: "Needs the customer",
};

/** The pipeline, as the stages a ticket passes through in order. */
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

export function AgentView({ panel }: { panel: AgentPanel }) {
  const { funnel, blockers, verdicts, automationCeiling, usage, usageByMonth, hasUsageData } = panel;

  if (!funnel) {
    return <EmptyState>No tickets have been ingested yet.</EmptyState>;
  }

  const investigations = verdicts.reduce((sum, v) => sum + v.investigations, 0);
  const orderJoin = funnel.tickets ? funnel.orderLinked / funnel.tickets : 0;

  return (
    <>
      <PanelSection
        title="What it costs"
        subtitle="Token counts are recorded per call and priced at read time, so a change to the rate card restates history instead of invalidating it."
      >
        {!hasUsageData || !usage ? (
          <>
            <TileGrid>
              <BlockedTile label="Spend this month" reason="No calls recorded yet" />
              <BlockedTile label="Tokens this month" reason="No calls recorded yet" />
              <BlockedTile label="Average per ticket" reason="No calls recorded yet" />
              <BlockedTile label="Worst single ticket" reason="No calls recorded yet" />
            </TileGrid>
            <Note title="Nothing has been recorded yet, and that is expected">
              Token capture was only just wired into the OpenAI transport. These tiles fill in as the worker
              runs — <code>npm run ingest:once</code> from <code>agent/</code>, or any of the{" "}
              <code>embed:*</code> scripts. Nothing can be backfilled: OpenAI reports usage on the response
              and nowhere else, so the history starts from the first call after wiring.
            </Note>
          </>
        ) : (
          <>
            <TileGrid>
              <StatTile
                label="Spend this month"
                value={usd(usage.monthToDateUsd)}
                foot={`${compactNumber(usage.monthToDateTokens)} tokens month to date`}
              />
              <StatTile
                label="Recorded spend"
                value={usd(usage.costUsd)}
                of={`${usage.calls.toLocaleString()} calls`}
                foot={`${compactNumber(usage.totalTokens)} tokens since ${
                  usage.firstRecordedAt ? formatMonth(usage.firstRecordedAt.slice(0, 10)) : "the first call"
                }`}
              />
              <StatTile
                label="Average per ticket"
                value={
                  usage.meanTokensPerTicket === null
                    ? "—"
                    : compactNumber(Math.round(usage.meanTokensPerTicket))
                }
                of="tokens"
                foot={`Across ${usage.ticketsTouched.toLocaleString()} tickets touched`}
              />
              <StatTile
                label="Worst single ticket"
                value={
                  usage.maxTokensOnATicket === null
                    ? "—"
                    : compactNumber(Math.round(usage.maxTokensOnATicket))
                }
                of="tokens"
                tone={
                  usage.maxTokensOnATicket !== null &&
                  usage.meanTokensPerTicket !== null &&
                  usage.maxTokensOnATicket > usage.meanTokensPerTicket * 8
                    ? "warn"
                    : "neutral"
                }
                foot="The runaway check — the investigation loop is bounded, and this is how you know it held"
              />
            </TileGrid>

            {usage.hasUnpricedModels ? (
              <Note tone="warn" title="Some spend is unpriced">
                At least one model in this window has no configured rate, so the money figures above are a
                floor rather than a total. Add it to <code>LLM_RATES</code> rather than editing the defaults.
              </Note>
            ) : null}

            <figure className={styles.figure}>
              <figcaption className={styles.figcaption}>
                <span className={styles.figTitle}>Tokens by month and model</span>
                <span className={styles.figSub}>
                  Investigation runs on the expensive tier; categorisation and the spam gate do not.
                </span>
              </figcaption>
              <BarList
                ariaLabel="Token usage by month and model"
                data={usageByMonth.map((m) => ({
                  key: `${m.month}-${m.model}-${m.pass}`,
                  label: `${formatMonth(m.month)} · ${m.model}`,
                  value: m.totalTokens,
                  display: compactNumber(m.totalTokens),
                  title: `${m.pass}: ${m.calls} calls, ${m.totalTokens.toLocaleString()} tokens, ${usd(
                    m.costUsd
                  )}${m.failedCalls ? ` — ${m.failedCalls} failed` : ""}`,
                }))}
              />
            </figure>

            <Note title="Prices are configuration, not fact">
              The default rates are list prices recorded so the panel has a number instead of a blank.
              Verify them against current OpenAI pricing before treating any figure here as real spend, and
              override with the <code>LLM_RATES</code> environment variable when they move.
            </Note>
          </>
        )}
      </PanelSection>

      <PanelSection
        title="What the agent is getting through"
        subtitle="Each stage is a count over the same set of tickets, so the drop-offs are directly comparable."
      >
        <TileGrid>
          <StatTile
            label="Tickets"
            value={funnel.tickets.toLocaleString()}
            foot={`${funnel.categorised.toLocaleString()} categorised`}
          />
          <StatTile
            label="Linked to an order"
            value={percent(funnel.orderLinked, funnel.tickets)}
            of={`${funnel.orderLinked} of ${funnel.tickets}`}
            tone={orderJoin < 0.5 ? "bad" : "good"}
            foot="The binding constraint on every metric that crosses email with commerce"
          />
          <StatTile
            label="Automation ceiling"
            value={automationCeiling === null ? "—" : `${(automationCeiling * 100).toFixed(0)}%`}
            of={investigations ? `of ${investigations} case files` : undefined}
            tone={automationCeiling !== null && automationCeiling < 0.4 ? "warn" : "good"}
            foot="Share the agent could have answered unaided"
          />
          <StatTile
            label="Awaiting investigation"
            value={funnel.awaitingInvestigation.toLocaleString()}
            tone={funnel.awaitingInvestigation > funnel.investigated ? "warn" : "neutral"}
            foot={`${funnel.lowConfidence} ticket(s) flagged low-confidence`}
          />
        </TileGrid>

        <div className={styles.split}>
          <figure className={styles.figure}>
            <figcaption className={styles.figcaption}>
              <span className={styles.figTitle}>The resolution funnel</span>
              <span className={styles.figSub}>Where tickets stop, in pipeline order.</span>
            </figcaption>
            <BarList
              ariaLabel="Tickets reaching each pipeline stage"
              data={funnelStages(funnel).map((s) => ({
                key: s.key,
                label: s.label,
                value: s.value,
                display: `${s.value.toLocaleString()} (${percent(s.value, funnel.tickets, 0)})`,
                emphasis: s.key === "order" && orderJoin < 0.5,
                title: `${s.value} of ${funnel.tickets} tickets reach "${s.label}"`,
              }))}
            />
          </figure>

          <figure className={styles.figure}>
            <figcaption className={styles.figcaption}>
              <span className={styles.figTitle}>Case files by verdict</span>
              <span className={styles.figSub}>
                What the investigation concluded it could do. {investigations} in total.
              </span>
            </figcaption>
            {verdicts.length === 0 ? (
              <EmptyState>Nothing investigated yet. Run `npm run investigate`.</EmptyState>
            ) : (
              <BarList
                ariaLabel="Investigations by verdict"
                data={verdicts.map((v) => ({
                  key: v.verdict,
                  label: VERDICT_LABELS[v.verdict] ?? v.verdict,
                  value: v.investigations,
                  display: `${v.investigations} (${percent(v.investigations, investigations, 0)})`,
                  emphasis: v.verdict !== "answerable",
                  title: `${v.investigations} case files — ${v.withHandoff} carry a handoff`,
                }))}
              />
            )}
          </figure>
        </div>
      </PanelSection>

      <PanelSection
        title="What is blocking the most tickets"
        subtitle="The needs the investigation recorded but could not satisfy, ranked by how many tickets they held up. Satisfied needs are excluded — the ledger records everything a ticket required, not only what failed."
      >
        {blockers.length === 0 ? (
          <EmptyState>
            No unmet evidence needs recorded. Either nothing has been investigated, or the agent got
            everything it asked for.
          </EmptyState>
        ) : (
          <>
            <BarList
              ariaLabel="Unmet evidence needs, by tickets blocked"
              data={blockers.slice(0, 10).map((b) => ({
                key: `${b.need}-${b.state}`,
                label: b.label,
                value: b.tickets,
                display: `${b.tickets}`,
                emphasis: b.tickets >= (blockers[0]?.tickets ?? 0) * 0.75,
                title: `${b.need} (${b.state ?? "unknown state"}${
                  b.finding ? `, found: ${b.finding}` : ""
                }) — ${b.tickets} tickets, ${b.occurrences} occurrences`,
              }))}
            />
            <Note title="This is a build list, not a chart">
              It is the system reporting its own blockers, so it stays current on its own. Whatever sits at
              the top is the data that would unblock the most mail if it existed — which makes it the
              cheapest place to spend the next unit of engineering.
            </Note>
          </>
        )}
      </PanelSection>
    </>
  );
}

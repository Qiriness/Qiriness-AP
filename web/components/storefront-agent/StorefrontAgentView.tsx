import type { ReactNode } from "react";
import type { FunnelStage, PeriodFigure, StorefrontAgentDashboard } from "@/lib/storefront-agent-types";
import { getFormat, getT } from "@/lib/i18n/server";
import { BarList, BlockedCard, Card, Caption, DeltaChip, EmptyState, Grid, KpiCard, SectionLabel, type Polarity } from "@/components/insights/InsightsKit";
import { TimeSeriesChart } from "@/components/insights/TimeSeriesChart";
import kit from "@/components/insights/InsightsKit.module.css";
import tables from "@/components/insights/tables.module.css";
import styles from "./StorefrontAgentView.module.css";

/**
 * The Storefront Agent dashboard: seven sections over one period, each figure
 * beside the period before when that period was recorded. A figure nothing
 * measures is « Not yet tracked » with its reason, never a zero.
 */
export function StorefrontAgentView({ data }: { data: StorefrontAgentDashboard }) {
  const t = getT();
  const f = getFormat();
  const compareLabel = data.coverage.previousCovered ? data.range.compareLabel : t("storefrontAgent.noComparison");
  const pct = (value: number | null, digits = 0) => (value === null ? "—" : f.percentOf(value * 100, digits));
  const secs = (ms: number | null) => (ms === null ? "—" : t("storefrontAgent.seconds", { n: f.decimal(ms / 1000, 1) }));
  const delta = (figure: PeriodFigure, polarity: Polarity, points = false) => (
    <DeltaChip
      current={points && figure.current !== null ? figure.current * 100 : figure.current}
      previous={points && figure.previous !== null ? figure.previous * 100 : figure.previous}
      polarity={polarity}
      points={points}
      compareLabel={compareLabel}
    />
  );
  const { kpis, sales, quality, technical } = data;
  const tracked = data.coverage.purchasesTracked;

  return (
    <>
      {data.coverage.liveTurnsFrom !== data.coverage.turnsFrom && data.coverage.turnsFrom ? (
        <Caption>
          {t("storefrontAgent.backfilledNote", {
            date: data.coverage.liveTurnsFrom ? new Date(data.coverage.liveTurnsFrom).toLocaleDateString(f.locale) : t("storefrontAgent.notTracked").toLowerCase(),
          })}
        </Caption>
      ) : null}

      {/* 1. Overview */}
      <SectionLabel>{t("storefrontAgent.s.overview")}</SectionLabel>
      <Grid min={13} pin="overview" label={t("storefrontAgent.s.overview")}>
        <KpiCard label={t("storefrontAgent.kpi.conversations")} value={f.integer(kpis.conversations.current ?? 0)} delta={delta(kpis.conversations, "up")} />
        {tracked ? (
          <KpiCard
            label={t("storefrontAgent.kpi.revenue")}
            value={f.euros(kpis.revenue.current)}
            delta={delta(kpis.revenue, "up")}
            sub={[{ label: t("storefrontAgent.kpi.incremental"), value: t("storefrontAgent.notTracked") }]}
          />
        ) : (
          <BlockedCard label={t("storefrontAgent.kpi.revenue")} reason="storefrontAgent.notTracked.purchases" />
        )}
        {tracked ? (
          <KpiCard label={t("storefrontAgent.kpi.orders")} value={f.integer(kpis.orders.current ?? 0)} delta={delta(kpis.orders, "up")} />
        ) : (
          <BlockedCard label={t("storefrontAgent.kpi.orders")} reason="storefrontAgent.notTracked.purchases" />
        )}
        {tracked ? (
          <KpiCard label={t("storefrontAgent.kpi.conversion")} value={pct(kpis.conversion.current, 1)} delta={delta(kpis.conversion, "up", true)} />
        ) : (
          <BlockedCard label={t("storefrontAgent.kpi.conversion")} reason="storefrontAgent.notTracked.purchases" />
        )}
        <KpiCard label={t("storefrontAgent.kpi.resolution")} value={pct(kpis.resolution.current)} delta={delta(kpis.resolution, "up", true)} />
        <KpiCard label={t("storefrontAgent.kpi.p95")} value={secs(kpis.p95.current)} delta={delta(kpis.p95, "down")} />
      </Grid>
      <Caption>{t("storefrontAgent.kpi.assistedHint")}</Caption>

      {/* 2. Engagement & conversion */}
      <SectionLabel>{t("storefrontAgent.s.engagement")}</SectionLabel>
      <Grid min={100} pin="funnel" label={t("storefrontAgent.s.engagement")}>
        <Card title={t("storefrontAgent.funnel.title")}>
          <Funnel stages={data.funnel} />
          <Caption>{t("storefrontAgent.funnel.note")}</Caption>
        </Card>
      </Grid>

      {/* 3. Sales */}
      <SectionLabel>{t("storefrontAgent.s.sales")}</SectionLabel>
      <Grid min={22} pin="sales-charts" label={t("storefrontAgent.s.sales")}>
        <Card title={t("storefrontAgent.sales.revenueOverTime")} span={2}>
          {tracked ? (
            <TimeSeriesChart points={sales.revenue} unit="euro" ariaLabel={t("storefrontAgent.sales.revenueOverTime")} />
          ) : (
            <EmptyState>{t("storefrontAgent.notTracked.purchases")}</EmptyState>
          )}
        </Card>
        {tracked ? (
          <KpiCard
            label={t("storefrontAgent.sales.aov")}
            value={f.euros(sales.aov.current, { cents: true })}
            delta={delta(sales.aov, "up")}
            sub={[{ label: t("storefrontAgent.kpi.orders"), value: f.integer(kpis.orders.current ?? 0) }]}
          />
        ) : (
          <BlockedCard label={t("storefrontAgent.sales.aov")} reason="storefrontAgent.notTracked.purchases" />
        )}
      </Grid>
      <Grid min={100} pin="conversations-chart" label={t("storefrontAgent.sales.conversationsOverTime")}>
        <Card title={t("storefrontAgent.sales.conversationsOverTime")}>
          <TimeSeriesChart points={sales.conversations} unit="count" ariaLabel={t("storefrontAgent.sales.conversationsOverTime")} />
        </Card>
      </Grid>
      <Grid min={30} pin="products" label={t("storefrontAgent.sales.products")}>
        <Card title={t("storefrontAgent.sales.products")} span={2}>
          {sales.products.length === 0 ? (
            <EmptyState>{t("storefrontAgent.sales.noProducts")}</EmptyState>
          ) : (
            <div className={tables.wrap}>
              <table className={tables.table}>
                <thead>
                  <tr>
                    <th>{t("storefrontAgent.sales.product")}</th>
                    <th className={tables.n}>{t("storefrontAgent.sales.shown")}</th>
                    <th className={tables.n}>{t("storefrontAgent.sales.clicked")}</th>
                    <th className={tables.n}>{t("storefrontAgent.sales.carted")}</th>
                    <th className={tables.n}>{t("storefrontAgent.sales.units")}</th>
                    <th className={tables.n}>{t("storefrontAgent.sales.sales")}</th>
                  </tr>
                </thead>
                <tbody>
                  {sales.products.map((p) => (
                    <tr key={p.productId}>
                      <th scope="row">{p.title ?? p.handle ?? p.productId}</th>
                      <td className={tables.n}>{f.integer(p.shown)}</td>
                      <td className={tables.n}>{f.integer(p.clicked)}</td>
                      <td className={tables.n}>{f.integer(p.carted)}</td>
                      <td className={`${tables.n} ${p.units === null ? tables.muted : ""}`}>{p.units === null ? "—" : f.integer(p.units)}</td>
                      <td className={`${tables.n} ${p.sales === null ? tables.muted : ""}`}>{p.sales === null ? "—" : f.euros(p.sales, { cents: true })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Caption>{tracked ? t("storefrontAgent.sales.productsNote") : `${t("storefrontAgent.sales.productsNote")} ${t("storefrontAgent.notTracked.purchases")}`}</Caption>
        </Card>
        <Card title={t("storefrontAgent.sales.byIntent")}>
          {!tracked ? (
            <EmptyState>{t("storefrontAgent.notTracked.purchases")}</EmptyState>
          ) : sales.byIntent.length === 0 ? (
            <EmptyState>{t("storefrontAgent.noData")}</EmptyState>
          ) : (
            <BarList
              ariaLabel={t("storefrontAgent.sales.byIntent")}
              data={sales.byIntent.map((row) => ({
                key: row.intent,
                label: t(`storefrontAgent.intent.${row.intent}`),
                value: row.revenue ?? 0,
                display: f.euros(row.revenue),
              }))}
            />
          )}
        </Card>
      </Grid>

      {/* 4. Agent quality */}
      <SectionLabel>{t("storefrontAgent.s.quality")}</SectionLabel>
      <Grid min={13} pin="quality" label={t("storefrontAgent.s.quality")}>
        <KpiCard
          label={t("storefrontAgent.q.resolution")}
          value={pct(quality.resolution.current)}
          delta={delta(quality.resolution, "up", true)}
          sub={[{ label: t("storefrontAgent.kpi.conversations"), value: f.integer(kpis.conversations.current ?? 0) }]}
        />
        <BlockedCard label={t("storefrontAgent.q.accuracy")} reason="storefrontAgent.notTracked.accuracy" />
        <KpiCard label={t("storefrontAgent.q.escalation")} value={pct(quality.escalation.current)} delta={delta(quality.escalation, "down", true)} />
        <KpiCard
          label={t("storefrontAgent.q.unanswered")}
          value={f.integer(quality.unanswered.turns)}
          unit={quality.unanswered.rate === null ? undefined : t("storefrontAgent.q.ofTurns", { pct: pct(quality.unanswered.rate, 1) })}
          delta={delta({ current: quality.unanswered.rate, previous: quality.unanswered.previousRate }, "down", true)}
        />
        <KpiCard label={t("storefrontAgent.q.errorRate")} value={pct(quality.errorRate.current, 1)} delta={delta(quality.errorRate, "down", true)} tone={(quality.errorRate.current ?? 0) > 0.05 ? "warn" : undefined} />
      </Grid>
      <Caption>
        {t("storefrontAgent.q.resolutionHint")} {t("storefrontAgent.q.escalationHint")} {t("storefrontAgent.q.unansweredHint")} {t("storefrontAgent.q.errorHint")}
      </Caption>

      {/* 5. Technical performance */}
      <SectionLabel>{t("storefrontAgent.s.technical")}</SectionLabel>
      <Grid min={13} pin="technical" label={t("storefrontAgent.s.technical")}>
        <KpiCard
          label={t("storefrontAgent.t.p50")}
          value={secs(technical.p50.current)}
          delta={delta(technical.p50, "down")}
          sub={[{ label: t("storefrontAgent.t.modelTime"), value: `${secs(technical.modelP50)} / ${secs(technical.modelP95)}` }]}
        />
        <KpiCard label={t("storefrontAgent.t.p95")} value={secs(technical.p95.current)} delta={delta(technical.p95, "down")} />
        <KpiCard
          label={t("storefrontAgent.t.failures")}
          value={f.integer(technical.failedTurns + technical.toolFailures)}
          sub={[
            { label: t("storefrontAgent.t.modelFailures"), value: f.integer(technical.failedTurns) },
            { label: t("storefrontAgent.t.toolFailures"), value: t("storefrontAgent.t.toolCalls", { failed: f.integer(technical.toolFailures), calls: f.integer(technical.toolCalls) }) },
          ]}
        />
        <KpiCard label={t("storefrontAgent.t.fallback")} value={pct(technical.fallbackRate.current, 1)} delta={delta(technical.fallbackRate, "down", true)} />
        <KpiCard
          label={t("storefrontAgent.t.tokens")}
          value={f.compactNumber(technical.inputTokens + technical.outputTokens)}
          sub={[
            { label: t("storefrontAgent.t.input"), value: f.compactNumber(technical.inputTokens) },
            { label: t("storefrontAgent.t.output"), value: f.compactNumber(technical.outputTokens) },
          ]}
        />
        <KpiCard
          label={t("storefrontAgent.t.cost")}
          value={f.usd(technical.costUsd.current)}
          delta={delta(technical.costUsd, "down")}
          sub={[{ label: t("storefrontAgent.t.costPerConversation"), value: f.usd(technical.costPerConversation.current) }]}
        />
      </Grid>
      <Grid min={22} pin="technical-detail" label={t("storefrontAgent.t.failures")}>
        <Card title={t("storefrontAgent.t.modelFailures")}>
          {technical.errors.length === 0 ? (
            <EmptyState>{t("storefrontAgent.t.noErrors")}</EmptyState>
          ) : (
            <BarList
              ariaLabel={t("storefrontAgent.t.modelFailures")}
              data={technical.errors.map((e) => ({ key: e.code, label: labelOr(t, `storefrontAgent.error.${e.code}`, e.code), value: e.turns }))}
            />
          )}
        </Card>
        <Card title={t("storefrontAgent.t.fallback")}>
          {technical.fallbacks.length === 0 ? (
            <EmptyState>{t("storefrontAgent.t.noFallbacks")}</EmptyState>
          ) : (
            <BarList
              ariaLabel={t("storefrontAgent.t.fallback")}
              data={technical.fallbacks.map((fb) => ({
                key: fb.kind,
                label: labelOr(t, `storefrontAgent.fallback.${fb.kind}`, fb.kind),
                value: fb.turns,
                display: `${f.integer(fb.turns)}  ·  ${f.percent(fb.turns, Math.max(1, technical.turns), 1)}`,
              }))}
            />
          )}
        </Card>
      </Grid>
      <Caption>{technical.unpriced ? `${t("storefrontAgent.t.listPrices")}. ${t("storefrontAgent.t.unpriced")}` : t("storefrontAgent.t.listPrices")}</Caption>

      {/* 6. Rule-based vs LLM */}
      <SectionLabel>{t("storefrontAgent.s.routes")}</SectionLabel>
      <Grid min={100} pin="routes" label={t("storefrontAgent.s.routes")}>
        <Card>
          {data.routes.length === 0 ? (
            <EmptyState>{t("storefrontAgent.noData")}</EmptyState>
          ) : (
            <div className={tables.wrap}>
              <table className={tables.table}>
                <thead>
                  <tr>
                    <th>{t("storefrontAgent.r.metric")}</th>
                    {data.routes.map((r) => (
                      <th key={r.route} className={tables.n}>{t(`storefrontAgent.route.${r.route}`)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <RouteRow label={t("storefrontAgent.r.requests")} cells={data.routes.map((r) => f.integer(r.turns))} />
                  <RouteRow label={t("storefrontAgent.r.latency")} cells={data.routes.map((r) => `${secs(r.p50)} / ${secs(r.p95)}`)} />
                  <RouteRow label={t("storefrontAgent.r.resolution")} cells={data.routes.map((r) => pct(r.resolution))} />
                  <RouteRow label={t("storefrontAgent.r.clickRate")} cells={data.routes.map((r) => pct(r.clickRate, 1))} />
                  <RouteRow label={t("storefrontAgent.r.cartRate")} cells={data.routes.map((r) => pct(r.cartRate, 1))} />
                  <RouteRow label={t("storefrontAgent.r.errorRate")} cells={data.routes.map((r) => pct(r.errorRate, 1))} />
                  <RouteRow label={t("storefrontAgent.r.cost")} cells={data.routes.map((r) => f.usd(r.costUsd))} />
                </tbody>
              </table>
            </div>
          )}
          <Caption>{t("storefrontAgent.r.note")}</Caption>
        </Card>
      </Grid>

      {/* 7. Performance by intent */}
      <SectionLabel>{t("storefrontAgent.s.intents")}</SectionLabel>
      <Grid min={100} pin="intents" label={t("storefrontAgent.s.intents")}>
        <Card>
          {data.intents.length === 0 ? (
            <EmptyState>{t("storefrontAgent.noData")}</EmptyState>
          ) : (
            <div className={tables.wrap}>
              <table className={tables.table}>
                <thead>
                  <tr>
                    <th>{t("storefrontAgent.i.intent")}</th>
                    <th className={tables.n}>{t("storefrontAgent.i.conversations")}</th>
                    <th className={tables.n}>{t("storefrontAgent.i.resolution")}</th>
                    <th className={tables.n}>{t("storefrontAgent.i.cartRate")}</th>
                    <th className={tables.n}>{t("storefrontAgent.i.conversion")}</th>
                    <th className={tables.n}>{t("storefrontAgent.i.revenue")}</th>
                    <th className={tables.n}>{t("storefrontAgent.i.latency")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.intents.map((i) => (
                    <tr key={i.intent}>
                      <th scope="row">{t(`storefrontAgent.intent.${i.intent}`)}</th>
                      <td className={tables.n}>{f.integer(i.conversations)}</td>
                      <td className={tables.n}>{pct(i.resolution)}</td>
                      <td className={tables.n}>{pct(i.cartRate, 1)}</td>
                      <td className={`${tables.n} ${i.conversion === null ? tables.muted : ""}`} title={i.conversion === null ? t("storefrontAgent.notTracked.purchases") : undefined}>
                        {pct(i.conversion, 1)}
                      </td>
                      <td className={`${tables.n} ${i.revenue === null ? tables.muted : ""}`} title={i.revenue === null ? t("storefrontAgent.notTracked.purchases") : undefined}>
                        {f.euros(i.revenue)}
                      </td>
                      <td className={tables.n}>{`${secs(i.p50)} / ${secs(i.p95)}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Caption>{t("storefrontAgent.i.note")}</Caption>
        </Card>
      </Grid>
    </>
  );
}

/** A translated label, or the raw code when the dictionary has none (a new error code). */
function labelOr(t: ReturnType<typeof getT>, key: string, fallback: string): string {
  const text = t(key);
  return text === key ? fallback : text;
}

function RouteRow({ label, cells }: { label: string; cells: ReactNode[] }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      {cells.map((cell, i) => (
        <td key={i} className={tables.n}>{cell}</td>
      ))}
    </tr>
  );
}

/**
 * The funnel, stage by stage, scaled against its widest tracked stage. An
 * untracked stage is hatched and says so; the step rate is against the last
 * tracked stage before it.
 */
function Funnel({ stages }: { stages: FunnelStage[] }) {
  const t = getT();
  const f = getFormat();
  const max = Math.max(1, ...stages.map((s) => s.value ?? 0));
  let previous: number | null = null;
  return (
    <ul className={kit.bars} aria-label={t("storefrontAgent.funnel.aria")}>
      {stages.map((stage) => {
        const step = stage.value !== null && previous !== null && previous > 0 ? f.percent(stage.value, previous, 0) : null;
        if (stage.value !== null) previous = stage.value;
        return (
          <li key={stage.key} className={kit.barRow} title={stage.reason ? t(stage.reason) : undefined}>
            <span className={kit.barKey}>{t(`storefrontAgent.funnel.${stage.key}`)}</span>
            <span className={kit.barTrack}>
              <span
                className={`${kit.barFill} ${stage.value === null ? kit.barMissing : ""}`}
                style={{ width: stage.value === null ? "100%" : `${((stage.value / max) * 100).toFixed(1)}%` }}
              />
            </span>
            <span className={`${kit.barValue} ${stage.value === null ? kit.barValueDim : ""}`}>
              {stage.value === null ? (
                t("storefrontAgent.notTracked")
              ) : (
                <>
                  {f.integer(stage.value)}
                  {step ? <span className={styles.step}>{t("storefrontAgent.funnel.ofPrevious", { pct: step })}</span> : null}
                </>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

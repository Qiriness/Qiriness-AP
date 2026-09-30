import type { NewsletterActivity, Grain } from "@/lib/types";
import { ColumnChart } from "./ColumnChart";
import { getFormat, getLocale, getT } from "@/lib/i18n/server";
import { formatDayL, pointWords } from "@/lib/insights-labels";
import { BlockedCard, Card, DeltaChip, Grid, KpiCard } from "./InsightsKit";

/** A month, for turning a per-day rate into a monthly one. */
const DAYS_PER_MONTH = 30.44;

/**
 * The newsletter over the selected range: how it moved, and how many
 * first-time buyers it had captured by the time they ordered.
 *
 * MOVED HERE FROM THE CUSTOMERS PANEL (2026-09-23), unchanged: the list is a
 * marketing channel, and these rows belong beside acquisition and promotions
 * rather than beside the customer base. Shopify customers only — marketplaces
 * mint one customer per order, so every read passes the Shopify filter.
 *
 * BOTH FIGURES ARE FLOORS. `customers` holds each person's CURRENT consent and
 * one timestamp, not a history, so somebody who joined and left inside the
 * range counts once, as a loss; and the chart hatches after the newest consent
 * change and before the earliest recorded unsubscribe.
 *
 * Server-rendered; the charts are client islands handed finished data.
 */
export function NewsletterRows({
  newsletter,
  grain,
  compareLabel,
}: {
  newsletter: NewsletterActivity;
  grain: Grain;
  compareLabel: string;
}) {
  const tr = getT();
  const locale = getLocale();
  const { integer, percent, percentOf } = getFormat(locale);
  const per = tr(`insights.sales.per.${grain}`);

  // --- churn: daily on short ranges, monthly on long ones, as the range reads.
  const daily = grain === "hour" || grain === "day";
  const churnOf = (m: NewsletterActivity["marketing"]["current"] | null) => {
    if (!m || m.listAtStart <= 0) return null;
    const perDay = m.unsubscribed / m.days / m.listAtStart;
    return (daily ? perDay : perDay * DAYS_PER_MONTH) * 100;
  };
  const { current: m, previous: mPrev } = newsletter.marketing;
  const churn = churnOf(m);
  const net = m.subscribed - m.unsubscribed;

  // --- capture
  const firstOrders = newsletter.capture.reduce((sum, p) => sum + p.firstOrders, 0);
  const before = newsletter.capture.reduce((sum, p) => sum + p.subscribedBefore, 0);
  const atCheckout = newsletter.capture.reduce((sum, p) => sum + p.subscribedAtCheckout, 0);

  return (
    <>
      <Grid min={17} pin="newsletter" label={tr("insights.marketing.nlRow")}>
        {newsletter.marketing.covered ? (
          <KpiCard
            label={daily ? tr("insights.marketing.churnDaily") : tr("insights.marketing.churnMonthly")}
            value={churn === null ? "—" : percentOf(churn, daily ? 2 : 1)}
            delta={<DeltaChip current={churn} previous={churnOf(mPrev)} polarity="down" compareLabel={compareLabel} />}
            sub={[
              { label: tr("insights.marketing.unsubscribed"), value: integer(m.unsubscribed) },
              { label: tr("insights.marketing.listStart"), value: integer(m.listAtStart) },
              { label: tr("insights.marketing.netChange"), value: `${net > 0 ? "+" : net < 0 ? "−" : ""}${integer(Math.abs(net))}` },
            ]}
          />
        ) : (
          <BlockedCard
            label={daily ? tr("insights.marketing.churnDaily") : tr("insights.marketing.churnMonthly")}
            reason={tr("insights.marketing.unsubFrom", { date: shortDate(newsletter.marketing.unsubscribesFrom, locale, tr) })}
          />
        )}
        <Card title={tr("insights.marketing.subsUnsubs", { per })} aside={<span>{tr("insights.marketing.floors")}</span>} span={2}>
          <ColumnChart
            unit="count"
            ariaLabel={tr("insights.marketing.subsUnsubsAria", { per })}
            height={240}
            missingLabel="insights.marketing.noConsent"
            series={[{ label: tr("insights.marketing.subscribed"), color: "var(--chart-1)" }]}
            negativeSeries={{ label: tr("insights.marketing.unsubscribed"), color: "var(--chart-2)" }}
            lineSeries={{ label: tr("insights.marketing.net"), color: "var(--chart-3)" }}
            data={newsletter.marketing.subscribed.map((point, i) => {
              const unsub = newsletter.marketing.unsubscribed[i]?.value ?? 0;
              const sub = point.value ?? 0;
              return {
                key: point.key,
                ...pointWords(point, tr, locale),
                state: point.state,
                segments: [sub],
                negative: unsub,
                line: point.state === "missing" ? null : sub - unsub,
              };
            })}
          />
        </Card>
      </Grid>

      <Grid min={17} pin="capture" label={tr("insights.marketing.captureRate")}>
        <Card title={tr("insights.marketing.firstBuyers", { per })} aside={<span>{tr("insights.marketing.shareFirst")}</span>} span={2}>
          <ColumnChart
            unit="count"
            ariaLabel={tr("insights.marketing.firstBuyersAria", { per })}
            height={240}
            missingLabel="insights.marketing.ordersNotSynced"
            series={[
              { label: tr("insights.marketing.subBefore"), color: "var(--chart-1)" },
              { label: tr("insights.marketing.atCheckout"), color: "var(--chart-3)" },
            ]}
            data={newsletter.capture.map((p) => ({
              key: p.key,
              ...pointWords(p, tr, locale),
              state: p.state,
              segments: [p.subscribedBefore, p.subscribedAtCheckout],
              top: p.firstOrders > 0 ? percent(p.subscribedBefore + p.subscribedAtCheckout, p.firstOrders, 0) : undefined,
              note: tr("insights.marketing.captureNote", {
                count: p.firstOrders,
                n: integer(p.firstOrders),
                pct: percent(p.subscribedBefore + p.subscribedAtCheckout, p.firstOrders, 0),
              }),
            }))}
          />
        </Card>
        <KpiCard
          label={tr("insights.marketing.captureRate")}
          value={firstOrders ? percent(before + atCheckout, firstOrders) : "—"}
          sub={[
            { label: tr("insights.marketing.subBefore"), value: percent(before, firstOrders, 0) },
            { label: tr("insights.marketing.atCheckout"), value: percent(atCheckout, firstOrders, 0) },
            { label: tr("insights.marketing.firstTime"), value: integer(firstOrders) },
          ]}
        />
      </Grid>
    </>
  );
}

/** `2025-04-17T...` -> `17 Apr 2025` / `17 avr. 2025`, for the churn card's reason. */
function shortDate(iso: string | null, locale: "fr" | "en", tr: (key: string) => string): string {
  if (!iso) return tr("insights.marketing.unknownDate");
  return formatDayL(new Date(iso), locale);
}

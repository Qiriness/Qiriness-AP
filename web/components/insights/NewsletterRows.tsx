import type { NewsletterActivity, Grain } from "@/lib/types";
import { ColumnChart } from "./ColumnChart";
import { BlockedCard, Card, DeltaChip, Grid, KpiCard, percent } from "./InsightsKit";

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
  const per = grain === "hour" ? "per hour" : grain === "day" ? "per day" : grain === "week" ? "per week" : "per month";

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
      <Grid min={17} pin="newsletter" label="Newsletter churn and movement">
        {newsletter.marketing.covered ? (
          <KpiCard
            label={daily ? "Newsletter churn, daily" : "Newsletter churn, monthly"}
            value={churn === null ? "—" : `${churn.toFixed(daily ? 2 : 1)}%`}
            delta={<DeltaChip current={churn} previous={churnOf(mPrev)} polarity="down" compareLabel={compareLabel} />}
            sub={[
              { label: "Unsubscribed", value: m.unsubscribed.toLocaleString("en-GB") },
              { label: "List at start (est.)", value: m.listAtStart.toLocaleString("en-GB") },
              { label: "Net change", value: `${net > 0 ? "+" : net < 0 ? "−" : ""}${Math.abs(net).toLocaleString("en-GB")}` },
            ]}
          />
        ) : (
          <BlockedCard
            label={daily ? "Newsletter churn, daily" : "Newsletter churn, monthly"}
            reason={`Unsubscribes are only recorded from ${shortDate(newsletter.marketing.unsubscribesFrom)} — pick a range that starts after it`}
          />
        )}
        <Card title={`Subscribes and unsubscribes, ${per}`} aside={<span>From each customer&apos;s latest consent change — floors</span>} span={2}>
          <ColumnChart
            unit="count"
            ariaLabel={`Newsletter subscribes and unsubscribes ${per}`}
            height={240}
            missingLabel="No consent change synced for this period yet"
            series={[{ label: "Subscribed", color: "var(--chart-1)" }]}
            negativeSeries={{ label: "Unsubscribed", color: "var(--chart-2)" }}
            lineSeries={{ label: "Net", color: "var(--chart-3)" }}
            data={newsletter.marketing.subscribed.map((point, i) => {
              const unsub = newsletter.marketing.unsubscribed[i]?.value ?? 0;
              const sub = point.value ?? 0;
              return {
                key: point.key,
                label: point.label,
                title: point.title,
                state: point.state,
                segments: [sub],
                negative: unsub,
                line: point.state === "missing" ? null : sub - unsub,
              };
            })}
          />
        </Card>
      </Grid>

      <Grid min={17} pin="capture" label="Capture rate">
        <Card title={`First-time buyers on the newsletter, ${per}`} aside={<span>% = share of first orders</span>} span={2}>
          <ColumnChart
            unit="count"
            ariaLabel={`First-time buyers who were on the newsletter ${per}`}
            height={240}
            missingLabel="Orders not synced for this period yet"
            series={[
              { label: "Subscribed before ordering", color: "var(--chart-1)" },
              { label: "Joined at checkout", color: "var(--chart-3)" },
            ]}
            data={newsletter.capture.map((p) => ({
              key: p.key,
              label: p.label,
              title: p.title,
              state: p.state,
              segments: [p.subscribedBefore, p.subscribedAtCheckout],
              top: p.firstOrders > 0 ? percent(p.subscribedBefore + p.subscribedAtCheckout, p.firstOrders, 0) : undefined,
              note: `${p.firstOrders.toLocaleString("en-GB")} first-time ${p.firstOrders === 1 ? "buyer" : "buyers"} · ${percent(
                p.subscribedBefore + p.subscribedAtCheckout,
                p.firstOrders,
                0
              )} captured`,
            }))}
          />
        </Card>
        <KpiCard
          label="Capture rate"
          value={firstOrders ? percent(before + atCheckout, firstOrders) : "—"}
          sub={[
            { label: "Subscribed before ordering", value: percent(before, firstOrders, 0) },
            { label: "Joined at checkout", value: percent(atCheckout, firstOrders, 0) },
            { label: "First-time buyers", value: firstOrders.toLocaleString("en-GB") },
          ]}
        />
      </Grid>
    </>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2025-04-17T...` -> `17 Apr 2025`, for the churn card's reason. */
function shortDate(iso: string | null): string {
  if (!iso) return "an unknown date";
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

import type { SupportPanel } from "@/lib/types";
import { CATEGORY_LABELS } from "@/lib/types";
import { DownloadIcon } from "@/components/icons";
import { BlockedCard, Card, DeltaChip, EmptyState, Grid, KpiCard, hours, percent } from "./InsightsKit";
import { SplitBar } from "./SplitBar";
import { TimeSeriesChart } from "./TimeSeriesChart";
import { TopicMap } from "./TopicMap";
import { perGrain } from "./grain";
import { formatAge } from "@/lib/insights-format";
import t from "./tables.module.css";

/**
 * Support over the chosen range: volume, mood, reply time, who is writing in,
 * what about — and the topic map, which belongs to its last rebuild rather than
 * to the range.
 */
export function SupportView({ panel, compareLabel }: { panel: SupportPanel; compareLabel: string }) {
  const { current, previous } = panel.summary;
  const grain = perGrain(panel.tickets);
  const mailNote = panel.mailBehind && panel.mailThrough ? `Mail synced to ${shortDate(panel.mailThrough)}` : null;

  const unhappyShare = current.tickets ? (current.unhappy / current.tickets) * 100 : null;
  const previousUnhappy = previous && previous.tickets ? (previous.unhappy / previous.tickets) * 100 : null;
  const contactRate = panel.orders.current ? (current.tickets / panel.orders.current) * 100 : null;
  const previousRate =
    previous && panel.orders.previous ? (previous.tickets / panel.orders.previous) * 100 : null;

  return (
    <>
      <Grid pin="headline" label="Support headline figures">
        <KpiCard
          label="Tickets"
          value={current.tickets.toLocaleString("en-GB")}
          delta={
            mailNote ? (
              <span className={t.muted}>{mailNote}</span>
            ) : (
              <DeltaChip current={current.tickets} previous={previous?.tickets} polarity="down" compareLabel={compareLabel} />
            )
          }
          sub={[
            { label: "Still open", value: current.stillOpen.toLocaleString("en-GB") },
            { label: "Level 3", value: current.levelThree.toLocaleString("en-GB") },
          ]}
        />
        {contactRate === null ? (
          <BlockedCard
            label="Contact rate"
            reason={mailNote ? `${mailNote} — tickets and orders would cover different days` : "No orders in this range"}
          />
        ) : (
          <KpiCard
            label="Contact rate"
            value={`${contactRate.toFixed(1)}%`}
            delta={<DeltaChip current={contactRate} previous={previousRate} polarity="down" points compareLabel={compareLabel} />}
            sub={[{ label: "Tickets per 100 orders", value: contactRate.toFixed(1) }]}
          />
        )}
        <KpiCard
          label="Unhappy customers"
          value={unhappyShare === null ? "—" : `${unhappyShare.toFixed(1)}%`}
          tone={unhappyShare !== null && unhappyShare > 30 ? "bad" : undefined}
          delta={<DeltaChip current={unhappyShare} previous={previousUnhappy} polarity="down" points compareLabel={compareLabel} />}
          sub={[
            { label: "Unhappy", value: current.unhappy.toLocaleString("en-GB") },
            { label: "Very unhappy", value: current.veryUnhappy.toLocaleString("en-GB") },
          ]}
        />
        {current.repliesMeasured > 0 ? (
          <KpiCard
            label="Median first reply"
            value={hours(current.p50ReplyHours)}
            tone={current.p50ReplyHours !== null && current.p50ReplyHours > 24 ? "bad" : undefined}
            delta={
              <DeltaChip current={current.p50ReplyHours} previous={previous?.p50ReplyHours} polarity="down" compareLabel={compareLabel} />
            }
            sub={[
              { label: "Within a day", value: percent(current.repliedWithin24h, current.repliesMeasured, 0) },
              { label: "Measured on", value: `${current.repliesMeasured} of ${current.tickets}` },
            ]}
          />
        ) : (
          <BlockedCard label="Median first reply" reason="No ticket in this range has a timed reply" />
        )}
      </Grid>

      <Grid min={100} pin="tickets-chart" label="Tickets chart">
        <Card title={`Tickets ${grain}`}>
          <TimeSeriesChart points={panel.tickets} unit="count" ariaLabel={`Tickets ${grain}`} missingLabel="Mail not synced for this period" />
        </Card>
      </Grid>

      <Grid min={26} pin="reply" label="First reply and who is writing">
        <Card title={`Median first reply, ${grain}`}>
          <TimeSeriesChart
            points={panel.medianReply}
            unit="hours"
            ariaLabel={`Median first reply ${grain}`}
            height={240}
            threshold={{ value: 24, label: "1 day" }}
            missingLabel="Mail not synced for this period"
          />
        </Card>
        <Card
          title="Who is writing to us"
          aside={
            panel.allTimeMarketable > 0 ? (
              // A link, built server-side, so no name or address enters this page.
              // Its label names its own count and scope: the export is all-time
              // and consented-only, unlike the ranged figures beside it.
              <a
                className={t.muted}
                href="/api/insights/support/marketable-contacts"
                download
                aria-label={`Download the ${panel.allTimeMarketable} consented contacts who never ordered online, all time, as CSV`}
                title={`CSV — the ${panel.allTimeMarketable} people (all time) who wrote in, never ordered online, and consented to marketing`}
              >
                <DownloadIcon size={16} /> {panel.allTimeMarketable} consented · CSV
              </a>
            ) : null
          }
        >
          <SplitBar
            total={current.tickets}
            parts={[
              { key: "buyer", label: "Verified online buyers", value: current.buyerTickets, color: "var(--chart-1)" },
              { key: "noorder", label: "Known, never ordered online", value: current.noOrderTickets, color: "var(--chart-2)" },
              { key: "unknown", label: "Address matches nothing", value: current.unknownTickets, color: "var(--chart-3)" },
            ]}
          />
          <dl className={t.facts}>
            <div>
              <dt>People who never ordered</dt>
              <dd>{current.noOrderCustomers.toLocaleString("en-GB")}</dd>
            </div>
            <div>
              <dt>Reachable</dt>
              <dd>{current.noOrderDeliverable.toLocaleString("en-GB")}</dd>
            </div>
            <div>
              <dt>Consented to marketing</dt>
              <dd>{current.noOrderMarketable.toLocaleString("en-GB")}</dd>
            </div>
          </dl>
        </Card>
      </Grid>

      <Grid min={100} pin="subjects" label="What people write about">
        <Card title="What people write about">
          {panel.categories.length === 0 ? (
            <EmptyState>No tickets in this range.</EmptyState>
          ) : (
            <div className={t.wrap}>
              <table className={t.table}>
                <thead>
                  <tr>
                    <th scope="col">Subject</th>
                    <th scope="col" className={t.n}>Tickets</th>
                    <th scope="col" className={t.n}>Share</th>
                    <th scope="col" className={t.n}>Still open</th>
                    <th scope="col" className={t.n}>Unhappy</th>
                    <th scope="col" className={t.n}>Level 3</th>
                    <th scope="col" className={t.n}>Mean happiness</th>
                    <th scope="col" className={t.n}>Never ordered</th>
                  </tr>
                </thead>
                <tbody>
                  {panel.categories.map((row) => (
                    <tr key={row.category ?? "uncategorised"}>
                      <th scope="row">
                        {row.category ? CATEGORY_LABELS[row.category] : <span className={t.muted}>Not categorised</span>}
                      </th>
                      <td className={t.n}>{row.tickets.toLocaleString("en-GB")}</td>
                      <td className={t.n}>{percent(row.tickets, current.tickets)}</td>
                      <td className={t.n}>{row.stillOpen.toLocaleString("en-GB")}</td>
                      <td className={t.n}>
                        {percent(row.unhappy, row.tickets, 0)} <span className={t.muted}>({row.unhappy})</span>
                      </td>
                      <td className={t.n}>{row.levelThree.toLocaleString("en-GB")}</td>
                      <td className={t.n}>
                        {row.meanHappiness === null ? <span className={t.muted}>—</span> : row.meanHappiness.toFixed(2)}
                      </td>
                      <td className={t.n}>
                        {row.noOrderTickets.toLocaleString("en-GB")}{" "}
                        <span className={t.muted}>({percent(row.noOrderTickets, row.tickets, 0)})</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </Grid>

      <Grid min={100} pin="topics" label="Topic map">
        <Card
          title="Topic map"
          aside={panel.topicMap ? <span>Built {formatAge(panel.topicMap.builtAt)} · all mail, not the range</span> : null}
        >
          {panel.topicMap ? (
            <TopicMap map={panel.topicMap} categories={panel.topicCategories} />
          ) : (
            <EmptyState>No topic map has been built yet. Run npm run cluster:tickets:save.</EmptyState>
          )}
        </Card>
      </Grid>
    </>
  );
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

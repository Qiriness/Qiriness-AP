import type { SupportPanel } from "@/lib/types";
import { DownloadIcon } from "@/components/icons";
import { getFormat, getLocale, getT } from "@/lib/i18n/server";
import { intlTag } from "@/lib/i18n/locales";
import { BlockedCard, Card, DeltaChip, EmptyState, Grid, KpiCard } from "./InsightsKit";
import { SplitBar } from "./SplitBar";
import { TimeSeriesChart } from "./TimeSeriesChart";
import { TopicMap } from "./TopicMap";
import { perGrain } from "./grain";
import t from "./tables.module.css";

/**
 * Support over the chosen range: volume, mood, reply time, who is writing in,
 * what about — and the topic map, which belongs to its last rebuild rather than
 * to the range.
 */
export function SupportView({ panel, compareLabel }: { panel: SupportPanel; compareLabel: string }) {
  const tr = getT();
  const locale = getLocale();
  const fmt = getFormat(locale);
  const { hours, integer, percent, percentOf, decimal } = fmt;
  const { current, previous } = panel.summary;
  const grain = tr(`insights.sales.per.${perGrain(panel.tickets)}`);
  const mailNote =
    panel.mailBehind && panel.mailThrough ? tr("insights.support.mailSyncedTo", { date: shortDate(panel.mailThrough, locale) }) : null;

  const unhappyShare = current.tickets ? (current.unhappy / current.tickets) * 100 : null;
  const previousUnhappy = previous && previous.tickets ? (previous.unhappy / previous.tickets) * 100 : null;
  const contactRate = panel.orders.current ? (current.tickets / panel.orders.current) * 100 : null;
  const previousRate =
    previous && panel.orders.previous ? (previous.tickets / panel.orders.previous) * 100 : null;

  return (
    <>
      <Grid pin="headline" label={tr("insights.support.headline")}>
        <KpiCard
          label={tr("insights.support.tickets")}
          value={integer(current.tickets)}
          delta={
            mailNote ? (
              <span className={t.muted}>{mailNote}</span>
            ) : (
              <DeltaChip current={current.tickets} previous={previous?.tickets} polarity="down" compareLabel={compareLabel} />
            )
          }
          sub={[
            { label: tr("insights.support.stillOpen"), value: integer(current.stillOpen) },
            { label: tr("level.3"), value: integer(current.levelThree) },
          ]}
        />
        {contactRate === null ? (
          <BlockedCard
            label={tr("insights.support.contactRate")}
            reason={mailNote ? tr("insights.support.differentDays", { note: mailNote }) : "insights.support.noOrders"}
          />
        ) : (
          <KpiCard
            label={tr("insights.support.contactRate")}
            value={percentOf(contactRate, 1)}
            delta={<DeltaChip current={contactRate} previous={previousRate} polarity="down" points compareLabel={compareLabel} />}
            sub={[{ label: tr("insights.support.per100"), value: decimal(contactRate, 1) }]}
          />
        )}
        <KpiCard
          label={tr("insights.support.unhappyCustomers")}
          value={unhappyShare === null ? "—" : percentOf(unhappyShare, 1)}
          tone={unhappyShare !== null && unhappyShare > 30 ? "bad" : undefined}
          delta={<DeltaChip current={unhappyShare} previous={previousUnhappy} polarity="down" points compareLabel={compareLabel} />}
          sub={[
            { label: tr("insights.support.unhappy"), value: integer(current.unhappy) },
            { label: tr("insights.support.veryUnhappy"), value: integer(current.veryUnhappy) },
          ]}
        />
        {current.repliesMeasured > 0 ? (
          <KpiCard
            label={tr("insights.support.medianReply")}
            value={hours(current.p50ReplyHours)}
            tone={current.p50ReplyHours !== null && current.p50ReplyHours > 24 ? "bad" : undefined}
            delta={
              <DeltaChip current={current.p50ReplyHours} previous={previous?.p50ReplyHours} polarity="down" compareLabel={compareLabel} />
            }
            sub={[
              { label: tr("insights.support.withinDay"), value: percent(current.repliedWithin24h, current.repliesMeasured, 0) },
              { label: tr("insights.support.measuredOn"), value: tr("insights.fulfilment.ofTotal", { n: integer(current.repliesMeasured), total: integer(current.tickets) }) },
            ]}
          />
        ) : (
          <BlockedCard label={tr("insights.support.medianReply")} reason="insights.support.noTimedReply" />
        )}
      </Grid>

      <Grid min={100} pin="tickets-chart" label={tr("insights.support.ticketsChart")}>
        <Card title={tr("insights.support.ticketsPer", { grain })}>
          <TimeSeriesChart points={panel.tickets} unit="count" ariaLabel={tr("insights.support.ticketsPer", { grain })} missingLabel="insights.support.mailNotSynced" />
        </Card>
      </Grid>

      <Grid min={26} pin="reply" label={tr("insights.support.replyRow")}>
        <Card title={tr("insights.support.medianReplyPer", { grain })}>
          <TimeSeriesChart
            points={panel.medianReply}
            unit="hours"
            ariaLabel={tr("insights.support.medianReplyPer", { grain })}
            height={240}
            threshold={{ value: 24, label: tr("insights.support.oneDay") }}
            missingLabel="insights.support.mailNotSynced"
          />
        </Card>
        <Card
          title={tr("insights.support.whoWrites")}
          aside={
            panel.allTimeMarketable > 0 ? (
              // A link, built server-side, so no name or address enters this page.
              // Its label names its own count and scope: the export is all-time
              // and consented-only, unlike the ranged figures beside it.
              <a
                className={t.muted}
                href="/api/insights/support/marketable-contacts"
                download
                aria-label={tr("insights.support.csvAria", { n: panel.allTimeMarketable })}
                title={tr("insights.support.csvTitle", { n: panel.allTimeMarketable })}
              >
                <DownloadIcon size={16} /> {tr("insights.support.csvLink", { n: panel.allTimeMarketable })}
              </a>
            ) : null
          }
        >
          <SplitBar
            total={current.tickets}
            parts={[
              { key: "buyer", label: tr("insights.support.buyers"), value: current.buyerTickets, color: "var(--chart-1)" },
              { key: "noorder", label: tr("insights.support.knownNever"), value: current.noOrderTickets, color: "var(--chart-2)" },
              { key: "unknown", label: tr("insights.support.matchesNothing"), value: current.unknownTickets, color: "var(--chart-3)" },
            ]}
          />
          <dl className={t.facts}>
            <div>
              <dt>{tr("insights.support.neverOrdered")}</dt>
              <dd>{integer(current.noOrderCustomers)}</dd>
            </div>
            <div>
              <dt>{tr("insights.support.reachable")}</dt>
              <dd>{integer(current.noOrderDeliverable)}</dd>
            </div>
            <div>
              <dt>{tr("insights.support.consented")}</dt>
              <dd>{integer(current.noOrderMarketable)}</dd>
            </div>
          </dl>
        </Card>
      </Grid>

      <Grid min={100} pin="subjects" label={tr("insights.support.writeAbout")}>
        <Card title={tr("insights.support.writeAbout")}>
          {panel.categories.length === 0 ? (
            <EmptyState>{tr("insights.support.noTickets")}</EmptyState>
          ) : (
            <div className={t.wrap}>
              <table className={t.table}>
                <thead>
                  <tr>
                    <th scope="col">{tr("insights.support.subject")}</th>
                    <th scope="col" className={t.n}>{tr("insights.support.tickets")}</th>
                    <th scope="col" className={t.n}>{tr("insights.sales.share")}</th>
                    <th scope="col" className={t.n}>{tr("insights.support.stillOpen")}</th>
                    <th scope="col" className={t.n}>{tr("insights.support.unhappy")}</th>
                    <th scope="col" className={t.n}>{tr("level.3")}</th>
                    <th scope="col" className={t.n}>{tr("insights.support.meanHappiness")}</th>
                    <th scope="col" className={t.n}>{tr("insights.support.neverOrderedShort")}</th>
                  </tr>
                </thead>
                <tbody>
                  {panel.categories.map((row) => (
                    <tr key={row.category ?? "uncategorised"}>
                      <th scope="row">
                        {row.category ? tr(`category.${row.category}`) : <span className={t.muted}>{tr("insights.support.notCategorised")}</span>}
                      </th>
                      <td className={t.n}>{integer(row.tickets)}</td>
                      <td className={t.n}>{percent(row.tickets, current.tickets)}</td>
                      <td className={t.n}>{integer(row.stillOpen)}</td>
                      <td className={t.n}>
                        {percent(row.unhappy, row.tickets, 0)} <span className={t.muted}>({row.unhappy})</span>
                      </td>
                      <td className={t.n}>{integer(row.levelThree)}</td>
                      <td className={t.n}>
                        {row.meanHappiness === null ? <span className={t.muted}>—</span> : decimal(row.meanHappiness, 2)}
                      </td>
                      <td className={t.n}>
                        {integer(row.noOrderTickets)}{" "}
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

      <Grid min={100} pin="topics" label={tr("insights.freshness.label.topics")}>
        <Card
          title={tr("insights.freshness.label.topics")}
          aside={panel.topicMap ? <span>{tr("insights.support.topicBuilt", { age: fmt.age(panel.topicMap.builtAt) })}</span> : null}
        >
          {panel.topicMap ? (
            <TopicMap map={panel.topicMap} categories={panel.topicCategories} />
          ) : (
            <EmptyState>{tr("insights.support.noTopicMap")} npm run cluster:tickets:save.</EmptyState>
          )}
        </Card>
      </Grid>
    </>
  );
}

function shortDate(iso: string, locale: "fr" | "en"): string {
  return new Date(iso).toLocaleDateString(intlTag(locale), { day: "numeric", month: "short" });
}

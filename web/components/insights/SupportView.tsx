import type { SupportPanel } from "@/lib/types";
import { CATEGORY_LABELS } from "@/lib/types";
import {
  BarList,
  BlockedTile,
  EmptyState,
  Note,
  PanelSection,
  StatTile,
  TileGrid,
  hours,
  percent,
} from "./InsightsKit";
import { formatMonth, isCurrentMonth } from "@/lib/insights-format";
import { TopicMap } from "./TopicMap";
import styles from "./SupportView.module.css";

/**
 * Support: how much mail arrives, what it is about, and how fast it is
 * answered.
 *
 * THE REPLY SECTION LEADS WITH ITS DENOMINATOR, not with its median. Only about
 * half the threads can be timed at all — the rest were never answered from the
 * synced mailbox, or arrived with no inbound message to measure from — and a
 * median printed without that number is a claim about the desk that the data
 * does not support. So the coverage tile sits first in that grid and the
 * section subtitle spells the attrition out before any duration appears.
 */
export function SupportView({ panel }: { panel: SupportPanel }) {
  const { byMonth, byCategory, replies, topicMap, totals, ordersFromMonth } = panel;

  // The store was trading before the mailbox was synced, so the first month of
  // the ticket series is part of a month of mail sitting over a whole month of
  // orders. Its contact rate is a floor, and without saying so it reads as the
  // quietest month on the chart — which is the shape a genuinely good month has.
  const firstMonth = byMonth[0] ?? null;
  const truncatedFirstMonth =
    firstMonth && ordersFromMonth && ordersFromMonth < firstMonth.month ? firstMonth : null;

  if (!totals || totals.tickets === 0) {
    return <EmptyState>No tickets have been ingested yet. Run the agent&apos;s ingestion pass.</EmptyState>;
  }

  const worstSubject = byCategory.reduce<(typeof byCategory)[number] | null>((acc, row) => {
    // Five tickets is the floor for calling a subject the worst: below that one
    // furious customer sets the mean and the headline is describing an
    // individual, not a subject.
    if (!row.category || row.meanHappiness === null || row.tickets < 5) return acc;
    if (!acc || row.meanHappiness > (acc.meanHappiness ?? 0)) return row;
    return acc;
  }, null);

  return (
    <>
      <PanelSection
        title="The desk"
        subtitle={`${totals.tickets.toLocaleString()} tickets ingested, ${byCategory
          .filter((row) => row.category !== null)
          .reduce((sum, row) => sum + row.tickets, 0)
          .toLocaleString()} of them categorised.`}
      >
        <TileGrid>
          <StatTile
            label="Tickets"
            value={totals.tickets.toLocaleString()}
            foot={`Across ${byMonth.length} month${byMonth.length === 1 ? "" : "s"} of synced mail`}
          />
          <StatTile
            label="Still open"
            value={totals.open.toLocaleString()}
            of={`of ${totals.tickets.toLocaleString()}`}
            tone={totals.open / totals.tickets > 0.25 ? "warn" : "neutral"}
            foot={`${percent(totals.open, totals.tickets)} not resolved or closed`}
          />
          <StatTile
            label="Unhappy customers"
            value={percent(totals.unhappy, totals.tickets)}
            tone={totals.unhappy / totals.tickets > 0.3 ? "bad" : "neutral"}
            foot={`${totals.unhappy.toLocaleString()} tickets scored 3 or 4, of which ${totals.veryUnhappy.toLocaleString()} scored 4`}
          />
          {replies && replies.measured > 0 ? (
            <StatTile
              label="Median first reply"
              value={hours(replies.p50Hours)}
              of={`over ${replies.measured.toLocaleString()}`}
              tone={replies.p50Hours !== null && replies.p50Hours > 24 ? "bad" : "good"}
              // The denominator travels with the figure, on the tile itself.
              // Someone screenshots a tile; nobody screenshots a tile and the
              // paragraph three sections below it.
              foot={`Measured on ${replies.measured} of ${replies.total} threads — see below`}
            />
          ) : (
            <BlockedTile
              label="Median first reply"
              reason="No thread has both an inbound message and a later outbound reply in the synced mailbox"
            />
          )}
        </TileGrid>

        <figure className={styles.figure}>
          <figcaption className={styles.figcaption}>
            <span className={styles.figTitle}>Tickets per month</span>
            <span className={styles.figSub}>
              In brackets, the month&apos;s tickets as a share of the orders placed in that same
              month — the contact rate. Both are calendar-month counts, not a cohort: a ticket about
              an order placed in June counts against July if it was written in July, so a single
              month&apos;s rate moves with when people wrote in as well as with how much sold.
              Months with no order row show the count alone rather than a rate. Months with no
              ingested mail are absent rather than drawn at zero, and the current month is partial
              and marked with an asterisk.
            </span>
          </figcaption>
          <BarList
            ariaLabel="Tickets received per month"
            data={byMonth.map((month) => {
              // Partial is decided here rather than in the view: whether a month
              // is still running depends on when the page is read, which is not
              // something SQL can know.
              const partial = isCurrentMonth(month.month);
              // No orders for the month means no rate — never "(0.0%)", which
              // would read as a month nobody wrote in about.
              const rate = month.orders ? ` (${percent(month.tickets, month.orders)})` : "";
              return {
                key: month.month,
                label: `${formatMonth(month.month)}${partial ? "*" : ""}`,
                value: month.tickets,
                display: `${month.tickets.toLocaleString()}${rate}${partial ? " so far" : ""}`,
                title: `${formatMonth(month.month)}: ${month.tickets} tickets${
                  month.orders
                    ? ` over ${month.orders.toLocaleString()} orders (${percent(
                        month.tickets,
                        month.orders
                      )})`
                    : " (no orders recorded for this month)"
                }, ${month.unhappy} unhappy, ${month.stillOpen} still open, median first reply ${hours(
                  month.p50ReplyHours
                )} over ${month.repliesMeasured} measured thread(s)${
                  partial ? " — month still in progress" : ""
                }`,
              };
            })}
          />
          {truncatedFirstMonth ? (
            <Note tone="warn" title={`${formatMonth(truncatedFirstMonth.month)} is a floor, not a quiet month`}>
              Orders go back to {formatMonth(ordersFromMonth!)}, but the synced mailbox starts in{" "}
              {formatMonth(truncatedFirstMonth.month)} — so that first bar counts part of a month of
              mail against a whole month of trading, and its{" "}
              {percent(truncatedFirstMonth.tickets, truncatedFirstMonth.orders ?? 0)} is the lowest
              rate on the chart for a reason that has nothing to do with customers. Compare the
              months after it; do not read the first one as a target.
            </Note>
          ) : null}
        </figure>
      </PanelSection>

      <PanelSection
        title="What people write about"
        subtitle="One row per subject. The view underneath groups on subject and request kind together, so these rows are folded back to the subject axis — otherwise delivery appears four times and no row states the number the business argues about."
      >
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Subject</th>
                <th scope="col" className={styles.n}>
                  Tickets
                </th>
                <th scope="col" className={styles.n}>
                  Share
                </th>
                <th scope="col" className={styles.n}>
                  Still open
                </th>
                <th scope="col" className={styles.n}>
                  Unhappy
                </th>
                <th scope="col" className={styles.n}>
                  Level 3
                </th>
                <th scope="col" className={styles.n}>
                  Mean happiness
                </th>
              </tr>
            </thead>
            <tbody>
              {byCategory.map((row) => (
                <tr key={row.category ?? "uncategorised"}>
                  <th scope="row">
                    {row.category ? (
                      CATEGORY_LABELS[row.category]
                    ) : (
                      <span className={styles.muted}>Not categorised</span>
                    )}
                  </th>
                  <td className={styles.n}>{row.tickets.toLocaleString()}</td>
                  <td className={styles.n}>{percent(row.tickets, totals.tickets)}</td>
                  <td className={styles.n}>{row.stillOpen.toLocaleString()}</td>
                  <td className={styles.n}>
                    {percent(row.unhappy, row.tickets)}{" "}
                    <span className={styles.muted}>({row.unhappy})</span>
                  </td>
                  <td className={styles.n}>{row.levelThree.toLocaleString()}</td>
                  <td className={styles.n}>
                    {row.meanHappiness === null ? (
                      // Never 0. On a 1-4 scale a zero would sort as the
                      // happiest subject on the board.
                      <span
                        className={styles.muted}
                        title="No ticket under this subject carries a happiness score"
                      >
                        —
                      </span>
                    ) : (
                      row.meanHappiness.toFixed(2)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {worstSubject ? (
          <Note tone="warn" title={`${CATEGORY_LABELS[worstSubject.category!]} is the sore subject`}>
            {percent(worstSubject.unhappy, worstSubject.tickets)} of its{" "}
            {worstSubject.tickets.toLocaleString()} tickets are scored unhappy and its mean happiness is{" "}
            {worstSubject.meanHappiness?.toFixed(2)} on a scale where 4 is angry — the worst of any
            subject with more than a handful of tickets. Worth reading beside the Fulfilment panel: the
            complaint is about the half of the journey this app currently cannot measure.
          </Note>
        ) : null}
      </PanelSection>

      <PanelSection
        title="First reply time"
        subtitle={
          replies
            ? `${replies.measured.toLocaleString()} of ${replies.total.toLocaleString()} threads can be timed at all. Everything in this section is computed over those ${replies.measured.toLocaleString()} and nothing else.`
            : "Nothing can be timed yet."
        }
      >
        {!replies || replies.measured === 0 ? (
          <TileGrid>
            <BlockedTile
              label="Median first reply"
              reason="No thread has an outbound message after its first inbound one"
            />
            <BlockedTile label="90th percentile" reason="Needs the same measurable threads" />
            <BlockedTile label="Answered within a day" reason="Needs the same measurable threads" />
          </TileGrid>
        ) : (
          <>
            <TileGrid>
              <StatTile
                label="Threads measurable"
                value={replies.measured.toLocaleString()}
                of={`of ${replies.total.toLocaleString()}`}
                tone={replies.measured / replies.total < 0.6 ? "warn" : "neutral"}
                foot={`${percent(
                  replies.measured,
                  replies.total
                )} coverage — this is the denominator for every figure beside it`}
              />
              <StatTile
                label="Median first reply"
                value={hours(replies.p50Hours)}
                tone={replies.p50Hours !== null && replies.p50Hours > 24 ? "bad" : "good"}
                foot="Half the measurable threads were answered faster than this"
              />
              <StatTile
                label="90th percentile"
                value={hours(replies.p90Hours)}
                tone={replies.p90Hours !== null && replies.p90Hours > 72 ? "bad" : "warn"}
                foot="One measurable thread in ten waited at least this long"
              />
              <StatTile
                label="Answered within a day"
                value={percent(replies.within24h, replies.measured)}
                of={`${replies.within24h} of ${replies.measured}`}
                tone={replies.within24h / replies.measured >= 0.5 ? "good" : "bad"}
                foot="Of the measurable threads only. The unmeasurable ones are not counted as fast or slow"
              />
            </TileGrid>

            <Note title="Where the other threads went">
              Of {replies.total.toLocaleString()} live tickets,{" "}
              {(replies.total - replies.measured).toLocaleString()} cannot be timed:{" "}
              some never received a reply from the synced mailbox at all, and some carry no inbound
              message to measure from — a contact-form ticket, or a thread whose opening mail predates
              the sync window. Neither group is an instant reply and neither is an infinite one, so
              neither is folded into the average. If a service-level figure is ever needed, the honest
              version is the unanswered count reported beside the median, not a mean over whatever
              happened to be timeable.
            </Note>

            <figure className={styles.figure}>
              <figcaption className={styles.figcaption}>
                <span className={styles.figTitle}>Median first reply by month</span>
                <span className={styles.figSub}>
                  Each bar carries its own denominator: a month where only a few threads could be timed
                  is a weak median, and the count beside the bar is what says so. Months with nothing
                  measurable are hatched, not drawn at zero.
                </span>
              </figcaption>
              <BarList
                ariaLabel="Median first reply time per month"
                data={byMonth.map((month) => {
                  const partial = isCurrentMonth(month.month);
                  return {
                    key: month.month,
                    label: `${formatMonth(month.month)}${partial ? "*" : ""}`,
                    value: month.p50ReplyHours,
                    missing: month.repliesMeasured === 0 || month.p50ReplyHours === null,
                    display: `${hours(month.p50ReplyHours)} · n=${month.repliesMeasured}`,
                    emphasis: (month.p50ReplyHours ?? 0) > 72,
                    title: `${formatMonth(month.month)}: median ${hours(
                      month.p50ReplyHours
                    )} over ${month.repliesMeasured} of ${month.tickets} tickets, ${
                      month.repliedWithin24h
                    } answered within a day${partial ? " — month still in progress" : ""}`,
                  };
                })}
              />
            </figure>
          </>
        )}
      </PanelSection>

      <PanelSection
        title="Topic map"
        subtitle="What the mail is actually about, found by clustering the message embeddings rather than by trusting the categoriser's labels — so it can surface a recurring complaint that no category was ever created for."
      >
        {topicMap ? (
          <TopicMap map={topicMap} categories={byCategory} />
        ) : (
          <EmptyState>
            No topic map has been built yet. Run <code>npm run cluster:tickets:save</code> from the
            repository root — it embeds nothing new, it only clusters what is already embedded, and it
            writes one run that this panel then reads.
          </EmptyState>
        )}
      </PanelSection>
    </>
  );
}

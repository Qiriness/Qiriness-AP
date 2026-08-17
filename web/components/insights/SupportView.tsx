import type { SupportPanel, SupportPurchaseCategory, SupportPurchaseStates } from "@/lib/types";
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
import { DownloadIcon } from "@/components/icons";
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
  const { purchaseStates, purchaseByCategory } = panel;

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

      {purchaseStates ? (
        <PurchaseStatesSection states={purchaseStates} byCategory={purchaseByCategory} />
      ) : null}

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

/**
 * Who is writing to us, split by whether we can see them buy online.
 *
 * THE MIDDLE GROUP IS THE SECTION. An address that matches a customer record
 * with zero orders is not a stranger and — this is the part the copy has to
 * carry — not a non-customer either. A physical-shop sale never reaches Shopify,
 * so a zero here means "we cannot see the purchase", never "there was none".
 * Three of these people have written a product review, which nobody does for a
 * product they never had.
 *
 * REACHABILITY IS TWO NUMBERS, NOT ONE, and on this store they are 22 and 8. A
 * working address and permission to send marketing are different questions, and
 * a single "reachable" tile would answer whichever one the reader happened to
 * assume — the more expensive assumption being the lawful one.
 */
function PurchaseStatesSection({
  states,
  byCategory
}: {
  states: SupportPurchaseStates;
  byCategory: SupportPurchaseCategory[];
}) {
  const unverified = states.noOrderTickets + states.unknownTickets;
  // Only subjects where someone unverified actually wrote. A table of fourteen
  // rows mostly reading zero buries the four that do not.
  const rows = byCategory.filter((row) => row.noOrderTickets > 0);

  return (
    <PanelSection
      title="Who is writing to us"
      subtitle="Split by whether the sender's address can be matched to an online purchase. This is a question about our records, not about the customer — a sale made in a physical shop never reaches Shopify, so an unmatched address is silence rather than a denial."
    >
      <TileGrid>
        <StatTile
          label="Verified online buyers"
          value={states.buyerTickets.toLocaleString()}
          of={`of ${states.tickets.toLocaleString()}`}
          foot={`${percent(states.buyerTickets, states.tickets)} of tickets — an order is visible behind the address`}
        />
        <StatTile
          label="Known, never ordered online"
          value={states.noOrderTickets.toLocaleString()}
          of={`from ${states.noOrderCustomers.toLocaleString()} people`}
          // Never "bad". These are customers we simply cannot see buy, and
          // several of them demonstrably own the product.
          tone="neutral"
          foot="In the customer list with zero orders: newsletter signups, Shop logins, or an address taken at a till"
        />
        <StatTile
          label="Address matches nothing"
          value={states.unknownTickets.toLocaleString()}
          of={`of ${states.tickets.toLocaleString()}`}
          tone={states.unknownTickets / Math.max(1, states.tickets) > 0.4 ? "warn" : "neutral"}
          foot={`${percent(states.unknownTickets, states.tickets)} — no customer record at all, so nothing can be checked`}
        />
        <StatTile
          label="Reachable of those people"
          value={states.noOrderDeliverable.toLocaleString()}
          of={`of ${states.noOrderCustomers.toLocaleString()}`}
          foot={`Usable address. Only ${states.noOrderMarketable.toLocaleString()} have consented to marketing — see below`}
          action={
            states.noOrderMarketable > 0 ? (
              // A plain link, not a fetch-and-blob: the file is built server-side
              // so the names and addresses never enter this page, which is
              // otherwise pure aggregates.
              //
              // THE ACCESSIBLE NAME CARRIES THE COUNT AND THE FILTER. The icon
              // shows neither, and the tile's headline figure is 22 while this
              // downloads 8 — so a control labelled only "Download" would read
              // as an export of everything above it. Both the tooltip and the
              // screen-reader name say which 8.
              <a
                href="/api/insights/support/marketable-contacts"
                download
                aria-label={`Download ${states.noOrderMarketable} consented contacts as CSV`}
                title={`Download CSV — the ${states.noOrderMarketable} people who have consented to marketing (name, email, ticket count, first and last contact dates, subjects). Not the other ${states.noOrderCustomers - states.noOrderMarketable}.`}
              >
                <DownloadIcon size={15} />
              </a>
            ) : null
          }
        />
      </TileGrid>

      <Note
        tone={states.noOrderMarketable < states.noOrderDeliverable ? "warn" : "info"}
        title="&ldquo;Reachable&rdquo; means two different things, and here they differ"
      >
        {states.noOrderDeliverable.toLocaleString()} of the{" "}
        {states.noOrderCustomers.toLocaleString()} people in the middle group have an address
        Shopify considers usable, so all of them can be <em>replied to</em>. Only{" "}
        {states.noOrderMarketable.toLocaleString()} carry marketing consent, which is the only
        figure an outreach campaign may be built on — the other{" "}
        {(states.noOrderDeliverable - states.noOrderMarketable).toLocaleString()} may be answered
        about their own ticket and not solicited. The counts are of people, not threads:{" "}
        {states.noOrderTickets.toLocaleString()} tickets came from{" "}
        {states.noOrderCustomers.toLocaleString()} senders, and a list built from the ticket count
        would be{" "}
        {(states.noOrderTickets / Math.max(1, states.noOrderCustomers)).toFixed(1)}× too long.
      </Note>

      {rows.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Subject</th>
                <th scope="col" className={styles.n}>
                  Tickets
                </th>
                <th scope="col" className={styles.n}>
                  Verified buyer
                </th>
                <th scope="col" className={styles.n}>
                  Never ordered
                </th>
                <th scope="col" className={styles.n}>
                  Unmatched
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.category ?? "uncategorised"}>
                  <th scope="row">
                    {row.category ? (
                      CATEGORY_LABELS[row.category]
                    ) : (
                      <span className={styles.muted}>Not categorised</span>
                    )}
                  </th>
                  <td className={styles.n}>{row.tickets.toLocaleString()}</td>
                  <td className={styles.n}>{row.buyerTickets.toLocaleString()}</td>
                  <td className={styles.n}>
                    {row.noOrderTickets.toLocaleString()}{" "}
                    <span className={styles.muted}>
                      ({percent(row.noOrderTickets, row.tickets, 0)})
                    </span>
                  </td>
                  <td className={styles.n}>{row.unknownTickets.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <Note title="What this section is for">
        {unverified.toLocaleString()} of {states.tickets.toLocaleString()} tickets (
        {percent(unverified, states.tickets)}) arrive from someone whose purchase we cannot see.
        The agent is told this rather than left to assume, because the two halves need opposite
        replies: a verified buyer can be answered from their order, while an unverified one has to
        be asked <em>where</em> they bought the product — a shop purchase changes which policy
        applies. What the agent must never do is turn &ldquo;no order found&rdquo; into &ldquo;you
        are not a customer&rdquo;.
      </Note>
    </PanelSection>
  );
}

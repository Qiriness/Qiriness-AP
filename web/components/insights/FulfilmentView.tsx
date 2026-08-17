import type {
  FulfilmentBucket,
  FulfilmentCarrier,
  FulfilmentChannelPanel,
  FulfilmentMonth,
  FulfilmentPanel,
  FulfilmentSummary,
  FulfilmentTicketCoverage,
} from "@/lib/types";
import {
  BarList,
  BlockedTile,
  EmptyState,
  Note,
  PanelSection,
  StatTile,
  TileGrid,
  euros,
  hours,
  percent,
} from "./InsightsKit";
import { formatMonth } from "@/lib/insights-format";
import styles from "./FulfilmentView.module.css";

/**
 * Fulfilment: how long orders take to leave the building, and — once a carrier
 * feed exists — how long they take to arrive.
 *
 * The two halves are laid out as two sections rather than interleaved, so the
 * blocked half reads as a section waiting on data instead of as a row of broken
 * tiles among working ones.
 */
export function FulfilmentView({ panel }: { panel: FulfilmentPanel }) {
  const { summary, byMonth, byCarrier, byBucket, hasDeliveryData, amazon, ticketCoverage } = panel;

  if (!summary || summary.orders === 0) {
    return <EmptyState>No orders have been synced yet. Run `npm run sync:shopify:orders`.</EmptyState>;
  }

  return (
    <>
      <PanelSection
        title="Order to dispatch"
        subtitle={`${summary.measured.toLocaleString()} of ${summary.orders.toLocaleString()} orders carry both timestamps, so this is measured on effectively the whole book.`}
      >
        <FulfilmentBreakdown summary={summary} byMonth={byMonth} byBucket={byBucket} noun="orders" />
      </PanelSection>

      {amazon ? <ChannelSection channel={amazon} storeOrders={summary.orders} /> : null}

      <PanelSection
        title="Delivery"
        subtitle="Dispatch to doorstep — the half of the journey nobody can currently see."
      >
        <TileGrid>
          <ReturnsRefundsTile summary={summary} />
          {hasDeliveryData ? null : (
            <>
              <BlockedTile
                label="Median delivery time"
                reason="No carrier scan events reach Shopify for this store"
              />
              <BlockedTile label="Delivered after 4 days" reason="Needs the same feed" />
              <BlockedTile
                label="Parcels stuck in transit"
                reason="Needs intermediate scans, not just a final delivery confirmation"
              />
              <StatTile
                label="Orders with a delivery date"
                value={summary.withDeliveryEvent.toLocaleString()}
                of={`of ${summary.orders.toLocaleString()}`}
                tone="blocked"
                foot="The coverage check behind the three blocked tiles"
              />
            </>
          )}
        </TileGrid>

        <ReturnsRefundsNote summary={summary} />

        {hasDeliveryData ? (
          <EmptyState>
            Delivery events are arriving. This section is ready for the median, the share past four days,
            and the stuck-parcel list.
          </EmptyState>
        ) : (
          <>
            <Note title="Why this is empty, and the cheapest way to fill it">
              The schema is already there — every fulfilment record carries <code>in_transit_at</code>,{" "}
              <code>estimated_delivery_at</code> and <code>delivered_at</code>, and{" "}
              <code>orders.tracking_numbers</code> is indexed so a parcel number joins straight back to an
              order. The events never arrive. Before assuming a 3PL integration is the only route, it is
              worth asking whether dispatch can post delivery confirmations onto the Shopify fulfilment:
              that fills these columns with no new table and no new sync, and every tile above turns on by
              itself.
            </Note>
          </>
        )}
      </PanelSection>

      <PanelSection
        title="Carriers"
        subtitle="Under Delivery rather than beside dispatch, because that is the question this table is here to answer: which carrier loses, breaks or delays parcels. Three of its columns are waiting on the feed above. Names are normalised before counting — the raw data spells Colissimo three ways, and a naive breakdown reports three carriers."
      >
        {byCarrier.length === 0 ? (
          <EmptyState>No carrier is recorded on any fulfilment yet.</EmptyState>
        ) : (
          <>
            <CarrierTable rows={byCarrier} />
            <ContactRateNote rows={byCarrier} coverage={ticketCoverage} />
            <DeliveryOutcomeNote />
          </>
        )}
      </PanelSection>
    </>
  );
}

/**
 * Orders that came back — the one measurable thing in an otherwise blocked
 * section.
 *
 * COUNTED PER ORDER, NOT PER REFUND, for the same reason the carrier contact
 * rate is: an order refunded twice is one unhappy order, and the other
 * arithmetic can exceed 100%.
 *
 * Returns and refunds are shown as **two figures in one tile rather than one
 * combined number**, because on this store they disagree in a way that is the
 * most interesting thing here: 3 refunds and 0 returns. Adding them together
 * would produce a single tidy rate that hides it.
 */
function ReturnsRefundsTile({ summary }: { summary: FulfilmentSummary }) {
  const { refundedOrders, returnsOpened, refundedAmount, fullyRefundedOrders, orders } = summary;

  // The column is newer than some deployed copies of the view. Absent is not
  // zero: "no order was ever refunded" is a claim, and this tile must not make
  // it on the strength of a missing key.
  if (refundedOrders === null) {
    return (
      <BlockedTile
        label="Returned or refunded"
        reason="fulfilment_summary has no refund columns yet — re-apply 06_analytics.sql"
      />
    );
  }

  const partial = fullyRefundedOrders !== null ? refundedOrders - fullyRefundedOrders : null;

  return (
    <StatTile
      label="Returned or refunded"
      value={refundedOrders.toLocaleString()}
      of={`of ${orders.toLocaleString()}`}
      // Deliberately never "good". A low refund rate is only good news if
      // everything that came back was recorded, and the note below says why
      // that is not established.
      tone={refundedOrders / Math.max(1, orders) > 0.05 ? "warn" : "neutral"}
      foot={`${percent(refundedOrders, orders)} of orders${
        refundedAmount !== null ? `, ${euros(refundedAmount)} refunded` : ""
      }${
        fullyRefundedOrders !== null
          ? ` — ${fullyRefundedOrders} in full, ${partial} in part`
          : ""
      }${returnsOpened !== null ? `. ${returnsOpened} returns opened` : ""}`}
    />
  );
}

/**
 * The sentence that stops a 0.1% refund rate reading as a compliment.
 *
 * `return_status` is `NO_RETURN` on all 2,006 orders — a recorded value, not a
 * null — so the zero is what Shopify holds rather than a sync gap, and saying
 * so is the difference between "we take no returns" and "we do not know". What
 * it cannot rule out is a return agreed over email and settled by hand, which
 * would never touch the field at all. Rendered from the figures rather than
 * written into the copy so it stops being a lie the day one comes back.
 */
function ReturnsRefundsNote({ summary }: { summary: FulfilmentSummary }) {
  const { refundedOrders, returnsOpened, orders } = summary;
  if (refundedOrders === null || returnsOpened === null) return null;

  return (
    <Note
      tone={returnsOpened === 0 && refundedOrders > 0 ? "warn" : "info"}
      title={
        returnsOpened === 0
          ? "No return has ever been opened in Shopify — read the refund rate with that in mind"
          : "How returns and refunds are counted here"
      }
    >
      {refundedOrders.toLocaleString()} of {orders.toLocaleString()} orders (
      {percent(refundedOrders, orders)}) carry a refund, counted once per order rather than once per
      refund line.{" "}
      {returnsOpened === 0 ? (
        <>
          <code>return_status</code> reads <code>NO_RETURN</code> on <em>every</em> order — that is a
          value Shopify recorded, not an empty column, so this is genuinely what the store holds. It
          still cannot tell you that nothing came back: a return agreed over email and settled by
          hand never touches the field, and the refunds above were issued without one. Before
          treating {percent(refundedOrders, orders)} as the return rate, it is worth knowing whether
          returns are meant to be raised in Shopify at all — if they are not, this figure is a floor
          and the real number lives in the support mailbox.
        </>
      ) : (
        <>
          {returnsOpened.toLocaleString()} returns were opened through Shopify. A return and a refund
          are separate events and are counted separately: one can happen without the other.
        </>
      )}
    </Note>
  );
}

/**
 * How a shipment ends, per carrier — the three columns this table exists for and
 * the three nothing can currently fill.
 *
 * PLACEHOLDERS ON PURPOSE, WITH THE SAME RULE AS EVERY OTHER BLOCKED FIGURE
 * HERE: they render as an em dash carrying a reason, never as `0`. "COLISSIMO:
 * 0 lost" is a claim about a carrier, and it is one nobody has measured — the
 * schema has no column that separates a lost parcel from a damaged or a late
 * one, and no carrier scan events arrive to derive it from.
 *
 * One list drives the headers and the cells so a column cannot be added to the
 * head and forgotten in the body, and so wiring them later is one `read` each.
 */
const DELIVERY_OUTCOMES: {
  key: "lost" | "damaged" | "late";
  label: string;
  read: (carrier: FulfilmentCarrier) => number | null;
}[] = [
  { key: "lost", label: "Lost", read: (c) => c.lost },
  { key: "damaged", label: "Damaged", read: (c) => c.damaged },
  { key: "late", label: "Delivered late", read: (c) => c.late },
];

/** Awaiting a source, or the count with its share of the carrier's shipments. */
function DeliveryOutcomeCell({
  value,
  shipments,
  label,
}: {
  value: number | null;
  shipments: number;
  label: string;
}) {
  if (value === null) {
    return (
      <td className={`${styles.n} ${styles.pending}`}>
        <span aria-hidden="true">—</span>
        <span className={styles.srOnly}>{label}: not measured yet</span>
      </td>
    );
  }
  return (
    <td className={styles.n}>
      {value.toLocaleString()} <span className={styles.muted}>({percent(value, shipments)})</span>
    </td>
  );
}

/**
 * Why three columns of this table are empty, in the table's own words.
 *
 * Deliberately a note rather than a tooltip: a reader who screenshots the
 * carrier table to send to a 3PL takes the dashes with them and not the hover
 * text, and an unexplained empty column reads as a bug in the dashboard rather
 * than as a gap in the data.
 */
function DeliveryOutcomeNote() {
  return (
    <Note title="Lost, damaged and late are placeholders — nothing writes them yet">
      The three right-hand columns are wired to the table and to nothing else. Neither source
      exists today: no carrier scan events reach Shopify, so the parcel&apos;s own history cannot
      supply them, and on the support side a ticket records only that its subject was{" "}
      <code>delivery</code> — a lost parcel, a broken bottle and a late one are the same row. They
      render as dashes rather than zeros because <em>zero lost parcels</em> is a claim about a
      carrier, and it is one nobody has measured. Filling them needs either the delivery feed
      described above, or a new classification axis on the ticket; the column that arrives first
      wins, and the type already allows both.
    </Note>
  );
}

/**
 * Carriers, with how often each one's shipments end in a support thread.
 *
 * `Contacted support` counts ORDERS, not threads: one parcel chased four times
 * is one unhappy delivery, and dividing threads by shipments would put a
 * six-shipment carrier over 100%. The thread count rides along in the same cell
 * so the difference between "many parcels went wrong" and "one went badly
 * wrong" stays visible.
 */
function CarrierTable({ rows }: { rows: FulfilmentCarrier[] }) {
  const total = rows.reduce((sum, c) => sum + c.shipments, 0);

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Carrier</th>
            <th scope="col">Shipments</th>
            <th scope="col">Share</th>
            <th scope="col">Median dispatch</th>
            <th scope="col">Past 3 days</th>
            <th scope="col">Contacted support</th>
            {DELIVERY_OUTCOMES.map((outcome) => (
              <th scope="col" key={outcome.key} className={styles.pending}>
                {outcome.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.carrier}>
              <th scope="row">{c.carrier}</th>
              <td className={styles.n}>{c.shipments.toLocaleString()}</td>
              <td className={styles.n}>{percent(c.shipments, total)}</td>
              <td className={styles.n}>{hours(c.p50Hours)}</td>
              <td className={styles.n}>
                {c.over72h.toLocaleString()}{" "}
                <span className={styles.muted}>({percent(c.over72h, c.shipments)})</span>
              </td>
              <td className={styles.n}>
                {c.ordersWithTicket.toLocaleString()}{" "}
                <span className={styles.muted}>
                  ({percent(c.ordersWithTicket, c.shipments)}
                  {c.tickets > c.ordersWithTicket ? `, ${c.tickets.toLocaleString()} threads` : ""})
                </span>
              </td>
              {DELIVERY_OUTCOMES.map((outcome) => (
                <DeliveryOutcomeCell
                  key={outcome.key}
                  value={outcome.read(c)}
                  shipments={c.shipments}
                  label={outcome.label}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The sentence the contact-rate column cannot be read without.
 *
 * A thread reaches a parcel only through a resolved order number, and most
 * threads never quote one — so every rate in that column is a floor, and the
 * ordering between carriers is the part worth acting on. Rendered from the
 * coverage view rather than written into the copy: the day the resolver runs
 * again, the caveat should shrink by itself instead of going stale.
 */
function ContactRateNote({
  rows,
  coverage,
}: {
  rows: FulfilmentCarrier[];
  coverage: FulfilmentTicketCoverage | null;
}) {
  if (!coverage || coverage.tickets === 0) return null;

  // Worth a warn tone only when the carriers actually disagree. Ranked by rate
  // over a floor of shipments — a 1-in-6 carrier tops any ratio you like and
  // says nothing.
  const ranked = rows
    .filter((c) => c.shipments >= 100)
    .sort((a, b) => b.ordersWithTicket / b.shipments - a.ordersWithTicket / a.shipments);
  const worst = ranked[0];
  const best = ranked[ranked.length - 1];
  const spread =
    worst && best && worst !== best && best.ordersWithTicket > 0
      ? worst.ordersWithTicket / worst.shipments / (best.ordersWithTicket / best.shipments)
      : null;

  return (
    <Note
      tone={spread !== null && spread >= 2 ? "warn" : "info"}
      title={
        spread !== null && spread >= 2
          ? `${worst.carrier} is contacted about ${spread.toFixed(1)}× as often as ${best.carrier}`
          : "Contact rate is a floor, not a rate"
      }
    >
      {spread !== null && spread >= 2 ? (
        <>
          {percent(worst.ordersWithTicket, worst.shipments)} of {worst.carrier} shipments produced a
          ticket against {percent(best.ordersWithTicket, best.shipments)} of {best.carrier} ones, over{" "}
          {worst.shipments.toLocaleString()} and {best.shipments.toLocaleString()} shipments. That gap is
          the signal here — the absolute rates are not.{" "}
        </>
      ) : null}
      A ticket can only be attributed to a parcel through an order number the resolver has confirmed, and{" "}
      {coverage.withOrderNumber.toLocaleString()} of {coverage.tickets.toLocaleString()} tickets carry one
      — a customer writes &ldquo;my parcel has not arrived&rdquo; far more often than they quote an order
      number. Every figure in that column is therefore a lower bound on the real contact rate. Running{" "}
      <code>orders:resolve</code> over the backlog is what would tighten it.
    </Note>
  );
}

/**
 * One sales channel, measured exactly as the store is measured directly above.
 *
 * The point of the section is the comparison, so it reuses the same component,
 * the same bucket boundaries and the same 72-hour line rather than a layout of
 * its own — two blocks that look alike can be read against each other, and two
 * that do not cannot.
 */
function ChannelSection({
  channel,
  storeOrders,
}: {
  channel: FulfilmentChannelPanel;
  storeOrders: number;
}) {
  const { summary, label } = channel;
  const untracked = summary.shippedWithoutTracking / Math.max(1, summary.measured);

  return (
    <PanelSection
      title={`${label} only`}
      subtitle={`The same measurements over the ${summary.orders.toLocaleString()} ${label} orders — ${percent(
        summary.orders,
        storeOrders
      )} of the book. A marketplace ships against its own promise, so the number that matters is the gap between this section and the one above.`}
    >
      <FulfilmentBreakdown
        summary={summary}
        byMonth={channel.byMonth}
        byBucket={channel.byBucket}
        noun={`${label} orders`}
      />

      {untracked >= 0.5 ? (
        <Note tone="warn" title={`Almost nothing sold through ${label} carries a tracking number here`}>
          {summary.shippedWithoutTracking.toLocaleString()} of {summary.measured.toLocaleString()}{" "}
          {label} orders — {percent(summary.shippedWithoutTracking, summary.measured, 0)} — were fulfilled
          with no tracking number on the Shopify record. The parcel number lives in the marketplace&apos;s
          own system and never comes back. That is not a dispatch failure, but it does mean a customer who
          bought through {label} and is chasing a parcel cannot be answered from this database by tracking
          number, and it is the same missing field that blocks the Delivery section below.
        </Note>
      ) : null}
    </PanelSection>
  );
}

/**
 * The tiles, the two figures and the outlier callout — the block that answers
 * "how long does dispatch take" for whatever set of orders it is handed.
 *
 * Shared between the store-wide section and each channel section so the two can
 * never drift into measuring subtly different things: one bucket boundary or one
 * threshold changed in a copy is a comparison that quietly stops being one.
 */
function FulfilmentBreakdown({
  summary,
  byMonth,
  byBucket,
  noun,
}: {
  summary: FulfilmentSummary;
  byMonth: FulfilmentMonth[];
  byBucket: FulfilmentBucket[];
  /** What a row is, for captions: "orders", "Amazon orders". */
  noun: string;
}) {
  // The worst complete month. Partial months are excluded rather than ranked:
  // three days into a month, one late order is 100%.
  const worst = byMonth.reduce<FulfilmentMonth | null>((acc, m) => {
    if (m.partial || !m.measured) return acc;
    if (!acc || m.over72h / m.measured > acc.over72h / acc.measured) return m;
    return acc;
  }, null);

  return (
    <>
      <TileGrid>
        <StatTile
          label="Median fulfilment"
          value={hours(summary.p50Hours)}
          foot={`Mean ${hours(summary.meanHours)} — the gap is the long tail`}
        />
        <StatTile
          label="90th percentile"
          value={hours(summary.p90Hours)}
          tone={summary.p90Hours !== null && summary.p90Hours > 72 ? "warn" : "neutral"}
          foot="One order in ten takes at least this long"
        />
        <StatTile
          label="Shipped after 3 days"
          value={summary.over72h.toLocaleString()}
          of={`of ${summary.measured.toLocaleString()}`}
          tone={summary.over72h / Math.max(1, summary.measured) > 0.1 ? "bad" : "good"}
          foot={`${percent(summary.over72h, summary.measured)} past 72 hours`}
        />
        <StatTile
          label="Shipped with no tracking"
          value={summary.shippedWithoutTracking.toLocaleString()}
          of={`of ${summary.measured.toLocaleString()}`}
          tone={summary.shippedWithoutTracking > 0 ? "warn" : "good"}
          foot="Those customers cannot self-serve, and their tickets cannot be resolved by parcel number"
        />
      </TileGrid>

      <div className={styles.split}>
        <figure className={styles.figure}>
          <figcaption className={styles.figcaption}>
            <span className={styles.figTitle}>How long orders take to ship</span>
            <span className={styles.figSub}>
              All {summary.measured.toLocaleString()} measured {noun}. Red is past three days.
            </span>
          </figcaption>
          <BarList
            ariaLabel={`Fulfilment time distribution for ${noun}`}
            data={byBucket.map((b) => ({
              key: b.bucket,
              label: b.bucket,
              value: b.orders,
              emphasis: b.late,
              title: `${b.orders.toLocaleString()} ${noun} shipped in ${b.bucket} (${percent(
                b.orders,
                summary.measured
              )})`,
            }))}
          />
        </figure>

        <figure className={styles.figure}>
          <figcaption className={styles.figcaption}>
            <span className={styles.figTitle}>Orders shipped after 72 hours</span>
            <span className={styles.figSub}>
              Share of each month. The current month is partial and marked.
            </span>
          </figcaption>
          <BarList
            ariaLabel={`Share of ${noun} shipped after 72 hours, by month`}
            data={byMonth.map((m) => {
              const rate = m.measured ? (m.over72h / m.measured) * 100 : 0;
              return {
                key: m.month,
                label: `${formatMonth(m.month)}${m.partial ? "*" : ""}`,
                value: rate,
                missing: m.measured === 0,
                display: m.measured ? `${rate.toFixed(1)}%` : "—",
                emphasis: rate >= 20,
                title: `${formatMonth(m.month)}: ${m.over72h} of ${m.measured} ${noun} past 72h, p90 ${hours(
                  m.p90Hours
                )}${m.partial ? " (month still in progress)" : ""}`,
              };
            })}
          />
        </figure>
      </div>

      {worst && worst.over72h / worst.measured >= 0.2 ? (
        <Note tone="warn" title={`${formatMonth(worst.month)} is the outlier`}>
          {percent(worst.over72h, worst.measured)} of that month&apos;s {worst.measured.toLocaleString()}{" "}
          {noun} took more than three days to ship, well above every other month in the series, and its
          90th percentile reached {hours(worst.p90Hours)}. Worth knowing whether that was a known staffing
          gap or news — it is the difference between a metric and an alert.
        </Note>
      ) : null}
    </>
  );
}

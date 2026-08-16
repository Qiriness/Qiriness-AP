"use client";

import { useMemo, useState } from "react";
import type { CustomerPanel } from "@/lib/types";
import { CATEGORY_LABELS, TICKET_HAPPINESS_MEANINGS, TICKET_LEVEL_LABELS } from "@/lib/types";
import {
  AT_RISK_SORTS,
  formatWait,
  sortAtRisk,
  type AtRiskSort,
} from "@/lib/insights-customers";
import {
  BarList,
  BlockedTile,
  EmptyState,
  Note,
  PanelSection,
  StatTile,
  TileGrid,
  compactNumber,
  euros,
  percent,
} from "./InsightsKit";
import styles from "./CustomersView.module.css";

/**
 * Customers: who they are, which of them support is actually spending its day
 * on, and which of those are worth a phone call.
 *
 * THE ORDER OF THE SECTIONS IS THE ARGUMENT. The call list comes first because
 * it is the only thing on the screen someone can act on this morning; the
 * denominators come second because every percentage after them depends on
 * reading them right; the VIP concentration comes third with its caveat
 * attached; the full segment table comes last, as reference rather than as a
 * finding. Putting the base counts first — the obvious layout — buries the
 * actionable list under 58,201 people who have never bought anything.
 *
 * "use client" FOR ONE REASON: the call list re-sorts between lifetime spend and
 * longest wait, which are two genuinely different questions ("who is the biggest
 * customer we are ignoring" vs "who have we ignored longest") and cannot both be
 * the server's order. Everything else here is pure rendering of a prop the
 * server already computed — no fetching, no effects.
 */
export function CustomersView({ panel }: { panel: CustomerPanel }) {
  const { segments, base, vip, vipByCategory, atRisk, spendExposed } = panel;

  const [sort, setSort] = useState<AtRiskSort>("spend");
  const callList = useMemo(() => sortAtRisk(atRisk, sort), [atRisk, sort]);

  if (!base || base.customers === 0) {
    return (
      <EmptyState>No customers have been synced yet. Run `npm run sync:shopify:customers`.</EmptyState>
    );
  }

  const { customers, buyers, repeatBuyers, marketingOptedIn } = base;
  const linked = vip?.ticketsLinked ?? 0;

  // Order + delivery are the two logistics subjects. Named here rather than in
  // the service because it is a reading of the chart, not a stored fact.
  const logisticsTickets = vipByCategory
    .filter((row) => row.category === "order" || row.category === "delivery")
    .reduce((total, row) => total + row.tickets, 0);

  return (
    <>
      {/*
        FIRST THING ON THE PAGE, DELIBERATELY. Everything below names real people
        and what they have spent, and the caveat is only useful before the reader
        has read them.
      */}
      <Note tone="warn" title="This screen names individual customers — and nothing is guarding it">
        The call list below prints customer names, segments and lifetime spend. The dashboard currently
        has <strong>no authentication, no role policy, and no personal-data access logging</strong> into{" "}
        <code>data_access_events</code>, so there is no record of who read this page or whose details they
        read. That is item 8 of the project&apos;s own Next Steps, and it is a prerequisite for this panel
        rather than a follow-up to it: until a dashboard identity exists there is nobody to attribute an
        access event to. Treat the URL as the only access control there is, and do not screenshot this
        section into a shared channel.
      </Note>

      <PanelSection
        title="Who to call today"
        subtitle={
          <>
            VIP customers — Champions and Loyal, the rule in{" "}
            <code>scripts/lib/customer-segments.mjs</code> — holding a ticket that is still open at level 3
            or above. Level 4 is included: it is an escalation above 3, not a separate track.
          </>
        }
        actions={
          callList.length > 1 ? (
            <div className={styles.sortGroup} role="group" aria-label="Sort the call list">
              {AT_RISK_SORTS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`${styles.sortButton} ${sort === option.id ? styles.sortActive : ""}`}
                  // aria-pressed rather than a styled-only active state: the
                  // difference between the two orders is the whole control, and
                  // a teal underline does not carry it to a screen reader.
                  aria-pressed={sort === option.id}
                  onClick={() => setSort(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null
        }
      >
        <TileGrid>
          <StatTile
            label="On the call list"
            value={callList.length.toLocaleString()}
            tone={callList.length > 0 ? "bad" : "good"}
            foot={
              callList.length > 0
                ? `${euros(callList.reduce((sum, row) => sum + row.amountSpent, 0))} of lifetime spend between them`
                : "No VIP is sitting on an unresolved level 3"
            }
          />
          {linked > 0 ? (
            <StatTile
              label="Spend exposed to an open complaint"
              value={euros(spendExposed)}
              tone={spendExposed > 0 ? "warn" : "good"}
              foot="Lifetime spend of every customer — VIP or not — with an open ticket they arrived at unhappy. Counted once per person, not once per ticket."
            />
          ) : (
            <BlockedTile
              label="Spend exposed to an open complaint"
              reason="No ticket resolves to a customer yet, so there is no spend to attach to one"
            />
          )}
          {/*
            The honest hole in this panel. Every figure here is drawn from tickets
            that matched a customer; the ones that did not match leave no row to
            count, so the size of the miss cannot be measured from this data at
            all. A zero here would be the exact opposite of the truth.
          */}
          <BlockedTile
            label="Tickets with no customer match"
            reason="Resolution matches on email hash; a sender who never bought under that address leaves no customer row, and this panel reads only matched tickets"
          />
        </TileGrid>

        {callList.length === 0 ? (
          <EmptyState>
            No VIP customer has an open ticket at level 3 or above right now. That is the good state —
            this list is meant to be empty.
          </EmptyState>
        ) : (
          <div className={styles.tableWrap}>
            <table className={`${styles.table} ${styles.callTable}`}>
              <caption className={styles.srOnly}>
                VIP customers with an open level 3 or higher ticket, sorted by{" "}
                {sort === "spend" ? "lifetime spend" : "how long they have waited"}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Customer</th>
                  <th scope="col">Segment</th>
                  <th scope="col">Lifetime spend</th>
                  <th scope="col">Issue</th>
                  <th scope="col">Level</th>
                  <th scope="col">Waiting</th>
                </tr>
              </thead>
              <tbody>
                {callList.map((row) => (
                  <tr key={row.ticketId} className={styles.vipRow}>
                    <th scope="row">
                      {row.customerName ?? <span className={styles.muted}>Name not synced</span>}
                      <span className={styles.sub}>
                        {row.numberOfOrders.toLocaleString()}{" "}
                        {row.numberOfOrders === 1 ? "order" : "orders"}
                      </span>
                    </th>
                    <td>
                      <span className={styles.vipBadge}>VIP</span>{" "}
                      <span className={styles.muted}>{row.label ?? "Unknown segment"}</span>
                    </td>
                    <td className={styles.n}>{euros(row.amountSpent)}</td>
                    <td>
                      {row.category ? CATEGORY_LABELS[row.category] : <span className={styles.muted}>Uncategorised</span>}
                    </td>
                    <td className={styles.n}>
                      {row.level ? TICKET_LEVEL_LABELS[row.level] : <span className={styles.muted}>—</span>}
                      {row.happiness ? (
                        <span className={styles.sub}>{TICKET_HAPPINESS_MEANINGS[row.happiness]}</span>
                      ) : null}
                    </td>
                    <td className={styles.n}>
                      {formatWait(row.firstMessageAt)}
                      <span className={styles.sub}>{statusLabel(row.status)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PanelSection>

      <PanelSection
        title="The customer base, and which denominator you are reading"
        subtitle={`${compactNumber(customers - buyers)} of ${compactNumber(
          customers
        )} customers have never placed an order. Every tile below names the denominator it used, because the same fact reads as 3% or as 18% depending on which one you pick — and only one of those is about customers.`}
      >
        <TileGrid>
          <StatTile
            label="Customers on file"
            value={compactNumber(customers)}
            foot="Everyone Shopify holds a record for, including newsletter signups who have never bought. The wrong denominator for almost everything."
          />
          <StatTile
            label="Buyers"
            value={compactNumber(buyers)}
            of={`of ${compactNumber(customers)} customers`}
            foot={`${percent(buyers, customers)} of customers have ever ordered. This is the denominator the rates below use.`}
          />
          <StatTile
            label="Repeat buyers"
            value={compactNumber(repeatBuyers)}
            of={`of ${compactNumber(buyers)} buyers`}
            tone={repeatBuyers / Math.max(1, buyers) >= 0.15 ? "good" : "neutral"}
            foot={`${percent(repeatBuyers, buyers)} of buyers — and ${percent(
              repeatBuyers,
              customers
            )} of customers. Both describe the same ${repeatBuyers.toLocaleString()} people.`}
          />
          <StatTile
            label="Marketing opt-ins"
            value={compactNumber(marketingOptedIn)}
            foot={`${percent(marketingOptedIn, customers)} of customers, ${percent(
              marketingOptedIn,
              buyers
            )} of buyers. Quoted against the customer list this looks like a failing programme; against buyers it does not.`}
          />
          {vip ? (
            <StatTile
              label="VIPs"
              value={compactNumber(vip.customers)}
              of={`of ${compactNumber(buyers)} buyers`}
              foot={`${percent(vip.customers, buyers)} of buyers are Champions or Loyal — ${percent(
                vip.customers,
                customers
              )} of the customer list.`}
            />
          ) : null}
        </TileGrid>

        <Note title="Which number to quote">
          Use <strong>buyers</strong> unless the question is genuinely about the mailing list. A prospect
          who signed up for a discount code and never returned is a real record and a real marketing
          contact, but they cannot have a repeat rate, an RFM position or a support history — so folding
          them into the denominator of any of those makes the rate a measure of how much list-building has
          happened, not of how customers behave. The two figures on each tile above are the same fact
          twice; the second one is there so nobody has to guess which was used.
        </Note>
      </PanelSection>

      <PanelSection
        title="VIPs are over-represented in support"
        subtitle={
          vip && linked > 0
            ? `${percent(vip.customers, buyers)} of the buyers, ${percent(
                vip.vipTickets,
                linked
              )} of the customer-linked tickets. Worth acting on, and worth reading with the caveat below attached.`
            : "How much of the support queue the best customers account for."
        }
      >
        {!vip || linked === 0 ? (
          <EmptyState>
            No ticket resolves to a customer yet. Run the customer-resolution pass before reading this
            section.
          </EmptyState>
        ) : (
          <>
            <TileGrid>
              <StatTile
                label="VIP share of buyers"
                value={percent(vip.customers, buyers)}
                foot={`${vip.customers.toLocaleString()} Champions and Loyal, of ${buyers.toLocaleString()} buyers`}
              />
              <StatTile
                label="VIP share of linked tickets"
                value={percent(vip.vipTickets, linked)}
                tone="warn"
                foot={`${vip.vipTickets.toLocaleString()} of ${linked.toLocaleString()} tickets that resolved to a customer`}
              />
              <StatTile
                label="Over-representation"
                value={overIndex(vip.vipTickets / linked, vip.customers / Math.max(1, buyers))}
                tone="warn"
                foot="How many times their share of buyers VIPs appear in the support queue"
              />
              {vip.contactRate === null ? (
                <BlockedTile
                  label="VIPs who contacted support"
                  reason="No VIP segment has any customers in it, so there is no base to divide by"
                />
              ) : (
                <StatTile
                  label="VIPs who contacted support"
                  // Already a rate, so the shared formatter is handed a whole of
                  // 1 rather than a second copy of the division — one place
                  // decides how many digits a percentage on this screen shows.
                  value={percent(vip.contactRate, 1)}
                  of={`of ${vip.customers.toLocaleString()} VIPs`}
                  foot="Distinct people, not tickets — someone who wrote four times about one parcel is one person who needed help."
                />
              )}
            </TileGrid>

            <Note title="Read the gap carefully — some of it is measurement, not behaviour">
              A ticket only appears here if customer resolution matched it, and it matches on{" "}
              <strong>email hash</strong>. Repeat buyers are structurally easier to match: they have
              ordered more often, from more addresses, with more chances for one of them to be the address
              they emailed from. A one-time buyer who wrote from a work account, or who checked out as a
              guest, silently never joins this dataset — and there is no way to count them from here, which
              is why the tile above is blocked rather than zero. So the honest version of this finding is:
              VIPs are over-represented in <em>matched</em> tickets by a wide margin, part of which is real
              (they buy more, so they have more parcels to go wrong) and part of which is matching bias of
              an unmeasured size. Both readings support giving them a queue; neither supports quoting the
              multiple as a behavioural fact.
            </Note>

            <figure className={styles.figure}>
              <figcaption className={styles.figcaption}>
                <span className={styles.figTitle}>What VIPs actually write in about</span>
                <span className={styles.figSub}>
                  {logisticsTickets > 0 ? (
                    <>
                      {percent(logisticsTickets, vip.vipTickets)} of VIP contact is logistics — orders and
                      delivery, highlighted. That is a fulfilment problem arriving as a support cost, not a
                      support problem.
                    </>
                  ) : (
                    <>All {vip.vipTickets.toLocaleString()} VIP tickets, by subject.</>
                  )}
                </span>
              </figcaption>
              {vipByCategory.length === 0 ? (
                <EmptyState>No VIP ticket carries a subject yet.</EmptyState>
              ) : (
                <BarList
                  ariaLabel="VIP tickets by subject"
                  data={vipByCategory.map((row) => ({
                    key: row.category ?? "uncategorised",
                    label: row.category ? CATEGORY_LABELS[row.category] : "Uncategorised",
                    value: row.tickets,
                    emphasis: row.category === "order" || row.category === "delivery",
                    title: `${row.tickets} VIP tickets (${percent(row.tickets, vip.vipTickets)} of VIP contact)`,
                  }))}
                />
              )}
            </figure>
          </>
        )}
      </PanelSection>

      <PanelSection
        title="Every segment"
        subtitle="Shopify's own RFM grouping, unedited. VIP is labelled, not inferred from the row's colour — the badge is the marking, and it comes from the shared rule rather than from this table."
      >
        {segments.length === 0 ? (
          <EmptyState>No segment totals were returned.</EmptyState>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Segment</th>
                  <th scope="col">Customers</th>
                  <th scope="col">Buyers</th>
                  <th scope="col">Repeat buyers</th>
                  <th scope="col">Marketing opt-in</th>
                  <th scope="col">Total spent</th>
                </tr>
              </thead>
              <tbody>
                {segments.map((segment) => (
                  <tr key={segment.rfmGroup ?? "none"} className={segment.isVip ? styles.vipRow : ""}>
                    <th scope="row">
                      {segment.label ?? <span className={styles.muted}>No segment</span>}
                      {segment.isVip ? <span className={styles.vipBadge}>VIP</span> : null}
                    </th>
                    <td className={styles.n}>{segment.customers.toLocaleString()}</td>
                    <td className={styles.n}>
                      {segment.buyers.toLocaleString()}{" "}
                      <span className={styles.muted}>({percent(segment.buyers, segment.customers, 0)})</span>
                    </td>
                    <td className={styles.n}>
                      {segment.repeatBuyers.toLocaleString()}{" "}
                      <span className={styles.muted}>
                        ({percent(segment.repeatBuyers, segment.buyers, 0)} of buyers)
                      </span>
                    </td>
                    <td className={styles.n}>
                      {segment.marketingOptedIn.toLocaleString()}{" "}
                      <span className={styles.muted}>
                        ({percent(segment.marketingOptedIn, segment.customers, 0)})
                      </span>
                    </td>
                    <td className={styles.n}>{euros(segment.totalSpent)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">All segments</th>
                  <td className={styles.n}>{customers.toLocaleString()}</td>
                  <td className={styles.n}>{buyers.toLocaleString()}</td>
                  <td className={styles.n}>{repeatBuyers.toLocaleString()}</td>
                  <td className={styles.n}>{marketingOptedIn.toLocaleString()}</td>
                  <td className={styles.n}>
                    {euros(segments.reduce((sum, segment) => sum + segment.totalSpent, 0))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </PanelSection>
    </>
  );
}

/**
 * "2.4x" — the multiple, not the difference in points.
 *
 * A gap of 31 points between 22% and 53% is arithmetically true and tells an
 * operator nothing about how concentrated the queue is; "VIPs turn up two and a
 * half times as often as their numbers imply" is the same figure in the form
 * that suggests an action.
 */
function overIndex(ticketShare: number, buyerShare: number): string {
  if (!Number.isFinite(ticketShare) || !buyerShare) return "—";
  return `${(ticketShare / buyerShare).toFixed(1)}x`;
}

/** The queue's status vocabulary, spelled for a reader rather than a column. */
function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

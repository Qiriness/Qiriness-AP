"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { CustomerPanel } from "@/lib/types";
import { CATEGORY_LABELS, TICKET_HAPPINESS_MEANINGS, TICKET_LEVEL_LABELS } from "@/lib/types";
import { AT_RISK_SORTS, formatWait, sortAtRisk, type AtRiskSort } from "@/lib/insights-customers";
import { BarList, Card, EmptyState, Grid, KpiCard, SectionLabel, compactNumber, euros, percent } from "./InsightsKit";
import { SegmentFinder } from "./SegmentFinder";
import { VipRuleCard } from "./VipRuleCard";
import t from "./tables.module.css";
import styles from "./CustomersView.module.css";

/**
 * Customers: who they are, what they did in the selected range, which of them
 * support spends its day on, and which of those are worth a phone call.
 *
 * TWO KINDS OF FIGURE, LABELLED APART. The base (buyers, VIPs, segments) is a
 * snapshot — `customers` holds current state, not a history — so it reads
 * "today" whatever the range. The `ranged` rows between them are server-rendered
 * by the page and passed in, so they follow the filter bar.
 *
 * "use client" for one reason: the call list re-sorts between lifetime spend
 * and longest wait, two different questions that cannot both be the server's
 * order.
 */
export function CustomersView({ panel, ranged }: { panel: CustomerPanel; ranged?: ReactNode }) {
  const { segments, base, vip, vipRule, vipByCategory, atRisk, spendExposed } = panel;
  const [sort, setSort] = useState<AtRiskSort>("spend");
  const callList = useMemo(() => sortAtRisk(atRisk, sort), [atRisk, sort]);

  if (!base || base.customers === 0) {
    return <EmptyState>No customers have been synced yet.</EmptyState>;
  }

  const { customers, buyers, repeatBuyers, marketingOptedIn } = base;
  const linked = vip?.ticketsLinked ?? 0;

  return (
    <>
      <p className={styles.privacy} role="note">
        This panel names individual customers, and the dashboard has no sign-in yet — do not share screenshots of it.
      </p>

      <VipRuleCard
        rule={vipRule}
        current={vip ? { vipCustomers: vip.customers, buyersInWindow: vip.buyersInWindow } : null}
      />

      <SectionLabel aside="As of the last sync">Customer base today</SectionLabel>
      <Grid pin="base" label="Customer base today">
        <KpiCard
          label="Buyers"
          value={compactNumber(buyers)}
          unit={`of ${compactNumber(customers)} on file`}
          sub={[{ label: "Share of customers who ever ordered", value: percent(buyers, customers) }]}
        />
        <KpiCard
          label="Repeat buyers"
          value={compactNumber(repeatBuyers)}
          sub={[{ label: "Of buyers", value: percent(repeatBuyers, buyers) }]}
        />
        <KpiCard
          label="VIPs"
          value={vip ? compactNumber(vip.customers) : "—"}
          sub={
            vip && vipRule
              ? [{ label: `Of ${vip.buyersInWindow.toLocaleString("en-GB")} who ordered in ${vipRule.windowMonths} months`, value: percent(vip.customers, vip.buyersInWindow) }]
              : [{ label: "No VIP rule set", value: "Set one above" }]
          }
        />
        <KpiCard
          label="Marketing opt-ins"
          value={compactNumber(marketingOptedIn)}
          sub={[
            { label: "Of customers", value: percent(marketingOptedIn, customers) },
            { label: "Of buyers", value: percent(marketingOptedIn, buyers) },
          ]}
        />
      </Grid>

      <SegmentFinder />

      {ranged ? (
        <>
          <SectionLabel aside="Shopify customers — marketplaces create one customer per order">In the selected range</SectionLabel>
          {ranged}
        </>
      ) : null}

      <SectionLabel aside="Open tickets, today">In support</SectionLabel>
      <Grid pin="support" label="VIPs in support">
        <KpiCard
          label="VIPs to call today"
          value={callList.length.toLocaleString("en-GB")}
          tone={callList.length > 0 ? "bad" : undefined}
          sub={[
            {
              label: "Their lifetime spend",
              value: euros(callList.reduce((sum, row) => sum + row.amountSpent, 0)),
            },
          ]}
        />
        <KpiCard
          label="Spend behind an open complaint"
          value={linked > 0 ? euros(spendExposed) : "—"}
          tone={spendExposed > 0 ? "warn" : undefined}
          sub={[{ label: "Customers counted once each", value: "Unhappy, still open" }]}
        />
        {vip && linked > 0 ? (
          <KpiCard
            label="VIP share of support"
            value={percent(vip.vipTickets, linked)}
            sub={[
              { label: "VIP share of window buyers", value: percent(vip.customers, vip.buyersInWindow) },
              { label: "VIPs who wrote in", value: vip.contactRate === null ? "—" : percent(vip.contactRate, 1) },
            ]}
          />
        ) : null}
      </Grid>

      <Grid min={100} pin="call-list" label="Who to call today">
        <Card
          title="Who to call today"
          aside={
            callList.length > 1 ? (
              <div className={styles.sortGroup} role="group" aria-label="Sort the call list">
                {AT_RISK_SORTS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`${styles.sortButton} ${sort === option.id ? styles.sortActive : ""}`}
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
          {!vipRule ? (
            <EmptyState>Set a VIP rule at the top of this page to build the call list.</EmptyState>
          ) : callList.length === 0 ? (
            <EmptyState>No VIP has an open ticket at level 3 or above.</EmptyState>
          ) : (
            <div className={t.wrap}>
              <table className={`${t.table} ${styles.callTable}`}>
                <caption className={t.srOnly}>
                  VIP customers with an open level 3 or higher ticket, sorted by{" "}
                  {sort === "spend" ? "lifetime spend" : "how long they have waited"}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Customer</th>
                    <th scope="col">Shopify segment</th>
                    <th scope="col" className={t.n}>Lifetime spend</th>
                    <th scope="col">Issue</th>
                    <th scope="col">Level</th>
                    <th scope="col" className={t.n}>Waiting</th>
                  </tr>
                </thead>
                <tbody>
                  {callList.map((row) => (
                    <tr key={row.ticketId}>
                      <th scope="row">
                        {row.customerName ?? <span className={t.muted}>Name not synced</span>}
                        <span className={t.sub}>
                          {row.numberOfOrders.toLocaleString("en-GB")} {row.numberOfOrders === 1 ? "order" : "orders"}
                        </span>
                      </th>
                      <td>
                        <span className={styles.vipBadge}>VIP</span>{" "}
                        <span className={t.muted}>{row.label ?? "Unknown segment"}</span>
                      </td>
                      <td className={t.n}>{euros(row.amountSpent)}</td>
                      <td>{row.category ? CATEGORY_LABELS[row.category] : <span className={t.muted}>Uncategorised</span>}</td>
                      <td>
                        {row.level ? TICKET_LEVEL_LABELS[row.level] : <span className={t.muted}>—</span>}
                        {row.happiness ? <span className={t.sub}>{TICKET_HAPPINESS_MEANINGS[row.happiness]}</span> : null}
                      </td>
                      <td className={t.n}>
                        {formatWait(row.firstMessageAt)}
                        <span className={t.sub}>{row.status.replace(/_/g, " ")}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </Grid>

      <Grid min={26} pin="segments" label="VIP subjects and Shopify segments">
        <Card title="What VIPs write in about">
          {vipByCategory.length === 0 ? (
            <EmptyState>No VIP ticket carries a subject yet.</EmptyState>
          ) : (
            <BarList
              ariaLabel="VIP tickets by subject"
              data={vipByCategory.map((row) => ({
                key: row.category ?? "uncategorised",
                label: row.category ? CATEGORY_LABELS[row.category] : "Uncategorised",
                value: row.tickets,
                display: `${row.tickets}  ·  ${percent(row.tickets, vip?.vipTickets ?? 0, 0)}`,
              }))}
            />
          )}
        </Card>
        <Card title="Shopify segments (RFM)" aside={<span>Shopify&apos;s own grouping — it does not decide VIP</span>}>
          <div className={t.wrap}>
            <table className={t.table}>
              <thead>
                <tr>
                  <th scope="col">Segment</th>
                  <th scope="col" className={t.n}>Customers</th>
                  <th scope="col" className={t.n}>Buyers</th>
                  <th scope="col" className={t.n}>Repeat</th>
                  <th scope="col" className={t.n}>Total spent</th>
                </tr>
              </thead>
              <tbody>
                {segments.map((segment) => (
                  <tr key={segment.rfmGroup ?? "none"}>
                    <th scope="row">{segment.label ?? <span className={t.muted}>No segment</span>}</th>
                    <td className={t.n}>{segment.customers.toLocaleString("en-GB")}</td>
                    <td className={t.n}>{segment.buyers.toLocaleString("en-GB")}</td>
                    <td className={t.n}>{segment.repeatBuyers.toLocaleString("en-GB")}</td>
                    <td className={t.n}>{euros(segment.totalSpent)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">All segments</th>
                  <td className={t.n}>{customers.toLocaleString("en-GB")}</td>
                  <td className={t.n}>{buyers.toLocaleString("en-GB")}</td>
                  <td className={t.n}>{repeatBuyers.toLocaleString("en-GB")}</td>
                  <td className={t.n}>{euros(segments.reduce((sum, s) => sum + s.totalSpent, 0))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
      </Grid>
    </>
  );
}

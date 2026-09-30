"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { CustomerPanel } from "@/lib/types";
import { AT_RISK_SORTS, formatWait, sortAtRisk, type AtRiskSort } from "@/lib/insights-customers";
import { useFormat, useT } from "@/lib/i18n/client";
import { BarList, Card, EmptyState, Grid, KpiCard, SectionLabel } from "./InsightsKit";
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
  const tr = useT();
  const { compactNumber, euros, integer, percent } = useFormat();
  const { segments, base, vip, vipRule, vipByCategory, atRisk, spendExposed } = panel;
  const [sort, setSort] = useState<AtRiskSort>("spend");
  const callList = useMemo(() => sortAtRisk(atRisk, sort), [atRisk, sort]);

  if (!base || base.customers === 0) {
    return <EmptyState>{tr("insights.customers.none")}</EmptyState>;
  }

  const { customers, buyers, repeatBuyers, marketingOptedIn } = base;
  const linked = vip?.ticketsLinked ?? 0;

  return (
    <>
      <VipRuleCard
        rule={vipRule}
        current={vip ? { vipCustomers: vip.customers, buyersInWindow: vip.buyersInWindow } : null}
      />

      <SectionLabel aside={tr("insights.customers.asOfSync")}>{tr("insights.customers.baseToday")}</SectionLabel>
      <Grid pin="base" label={tr("insights.customers.baseToday")}>
        <KpiCard
          label={tr("insights.customers.buyers")}
          value={compactNumber(buyers)}
          unit={tr("insights.customers.onFile", { n: compactNumber(customers) })}
          sub={[{ label: tr("insights.customers.everOrdered"), value: percent(buyers, customers) }]}
        />
        <KpiCard
          label={tr("insights.customers.repeatBuyers")}
          value={compactNumber(repeatBuyers)}
          sub={[{ label: tr("insights.customers.ofBuyers"), value: percent(repeatBuyers, buyers) }]}
        />
        <KpiCard
          label={tr("insights.customers.vips")}
          value={vip ? compactNumber(vip.customers) : "—"}
          sub={
            vip && vipRule
              ? [{ label: tr("insights.customers.ofWindow", { n: integer(vip.buyersInWindow), months: vipRule.windowMonths }), value: percent(vip.customers, vip.buyersInWindow) }]
              : [{ label: tr("insights.customers.noRule"), value: tr("insights.customers.setAbove") }]
          }
        />
        <KpiCard
          label={tr("insights.customers.optIns")}
          value={compactNumber(marketingOptedIn)}
          sub={[
            { label: tr("insights.customers.ofCustomers"), value: percent(marketingOptedIn, customers) },
            { label: tr("insights.customers.ofBuyers"), value: percent(marketingOptedIn, buyers) },
          ]}
        />
      </Grid>

      <Grid min={100} pin="segment-finder" label={tr("insights.customers.finder")}>
        <SegmentFinder />
      </Grid>

      {ranged ? (
        <>
          <SectionLabel aside={tr("insights.customers.rangedAside")}>{tr("insights.customers.inRange")}</SectionLabel>
          {ranged}
        </>
      ) : null}

      <SectionLabel aside={tr("insights.customers.openToday")}>{tr("insights.customers.inSupport")}</SectionLabel>
      <Grid pin="support" label={tr("insights.customers.vipsInSupport")}>
        <KpiCard
          label={tr("insights.customers.toCall")}
          value={integer(callList.length)}
          tone={callList.length > 0 ? "bad" : undefined}
          sub={[
            {
              label: tr("insights.customers.lifetimeOf"),
              value: euros(callList.reduce((sum, row) => sum + row.amountSpent, 0)),
            },
          ]}
        />
        <KpiCard
          label={tr("insights.customers.exposed")}
          value={linked > 0 ? euros(spendExposed) : "—"}
          tone={spendExposed > 0 ? "warn" : undefined}
          sub={[{ label: tr("insights.customers.countedOnce"), value: tr("insights.customers.unhappyOpen") }]}
        />
        {vip && linked > 0 ? (
          <KpiCard
            label={tr("insights.customers.vipShare")}
            value={percent(vip.vipTickets, linked)}
            sub={[
              { label: tr("insights.customers.vipShareBuyers"), value: percent(vip.customers, vip.buyersInWindow) },
              { label: tr("insights.customers.vipsWrote"), value: vip.contactRate === null ? "—" : percent(vip.contactRate, 1) },
            ]}
          />
        ) : null}
      </Grid>

      <Grid min={100} pin="call-list" label={tr("insights.customers.whoToCall")}>
        <Card
          title={tr("insights.customers.whoToCall")}
          aside={
            callList.length > 1 ? (
              <div className={styles.sortGroup} role="group" aria-label={tr("insights.customers.sortList")}>
                {AT_RISK_SORTS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`${styles.sortButton} ${sort === option.id ? styles.sortActive : ""}`}
                    aria-pressed={sort === option.id}
                    onClick={() => setSort(option.id)}
                  >
                    {tr(`insights.customers.sort.${option.id}`)}
                  </button>
                ))}
              </div>
            ) : null
          }
        >
          {!vipRule ? (
            <EmptyState>{tr("insights.customers.setRule")}</EmptyState>
          ) : callList.length === 0 ? (
            <EmptyState>{tr("insights.customers.noVipOpen")}</EmptyState>
          ) : (
            <div className={t.wrap}>
              <table className={`${t.table} ${styles.callTable}`}>
                <caption className={t.srOnly}>
                  {tr("insights.customers.callCaption", { by: tr(sort === "spend" ? "insights.customers.byLifetime" : "insights.customers.byWait") })}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{tr("insights.fulfilment.open.customer")}</th>
                    <th scope="col">{tr("tickets.panels.row.segment")}</th>
                    <th scope="col" className={t.n}>{tr("insights.customers.sort.spend")}</th>
                    <th scope="col">{tr("insights.customers.issue")}</th>
                    <th scope="col">{tr("tickets.panels.row.level")}</th>
                    <th scope="col" className={t.n}>{tr("insights.customers.waiting")}</th>
                  </tr>
                </thead>
                <tbody>
                  {callList.map((row) => (
                    <tr key={row.ticketId}>
                      <th scope="row">
                        {row.customerName ?? <span className={t.muted}>{tr("insights.customers.nameNotSynced")}</span>}
                        <span className={t.sub}>
                          {tr("insights.sales.ordersCount", { count: row.numberOfOrders })}
                        </span>
                      </th>
                      <td>
                        <span className={styles.vipBadge}>VIP</span>{" "}
                        <span className={t.muted}>{row.label ?? tr("insights.customers.unknownSegment")}</span>
                      </td>
                      <td className={t.n}>{euros(row.amountSpent)}</td>
                      <td>{row.category ? tr(`category.${row.category}`) : <span className={t.muted}>{tr("tickets.panels.uncategorised")}</span>}</td>
                      <td>
                        {row.level ? tr(`level.${row.level}`) : <span className={t.muted}>—</span>}
                        {row.happiness ? <span className={t.sub}>{tr(`insights.customers.mood.${row.happiness}`)}</span> : null}
                      </td>
                      <td className={t.n}>
                        {formatWait(row.firstMessageAt, tr)}
                        <span className={t.sub}>{tr(`status.${row.status}`) === `status.${row.status}` ? row.status.replace(/_/g, " ") : tr(`status.${row.status}`)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </Grid>

      <Grid min={26} pin="segments" label={tr("insights.customers.segmentsRow")}>
        <Card title={tr("insights.customers.vipAbout")}>
          {vipByCategory.length === 0 ? (
            <EmptyState>{tr("insights.customers.noVipSubject")}</EmptyState>
          ) : (
            <BarList
              ariaLabel={tr("insights.customers.vipBySubject")}
              data={vipByCategory.map((row) => ({
                key: row.category ?? "uncategorised",
                label: row.category ? tr(`category.${row.category}`) : tr("tickets.panels.uncategorised"),
                value: row.tickets,
                display: `${row.tickets}  ·  ${percent(row.tickets, vip?.vipTickets ?? 0, 0)}`,
              }))}
            />
          )}
        </Card>
        <Card title={tr("insights.customers.rfm")} aside={<span>{tr("insights.customers.rfmAside")}</span>}>
          <div className={t.wrap}>
            <table className={t.table}>
              <thead>
                <tr>
                  <th scope="col">{tr("insights.customers.segment")}</th>
                  <th scope="col" className={t.n}>{tr("insights.sales.customers")}</th>
                  <th scope="col" className={t.n}>{tr("insights.customers.buyers")}</th>
                  <th scope="col" className={t.n}>{tr("insights.customers.repeat2")}</th>
                  <th scope="col" className={t.n}>{tr("insights.customers.totalSpent")}</th>
                </tr>
              </thead>
              <tbody>
                {segments.map((segment) => (
                  <tr key={segment.rfmGroup ?? "none"}>
                    <th scope="row">{segment.label ?? <span className={t.muted}>{tr("insights.customers.noSegment")}</span>}</th>
                    <td className={t.n}>{integer(segment.customers)}</td>
                    <td className={t.n}>{integer(segment.buyers)}</td>
                    <td className={t.n}>{integer(segment.repeatBuyers)}</td>
                    <td className={t.n}>{euros(segment.totalSpent)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">{tr("insights.customers.allSegments")}</th>
                  <td className={t.n}>{integer(customers)}</td>
                  <td className={t.n}>{integer(buyers)}</td>
                  <td className={t.n}>{integer(repeatBuyers)}</td>
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

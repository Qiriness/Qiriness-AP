"use client";

import { useState } from "react";
import Link from "next/link";
import type { OpenOrder } from "@/lib/types";
import { useFormat, useLocale, useT } from "@/lib/i18n/client";
import { formatDayL } from "@/lib/insights-labels";
import { Segmented } from "./Segmented";
import t from "./tables.module.css";
import styles from "./OpenOrders.module.css";
// The ring is the Orders page's own, so an order reads the same on both.
import ordersCss from "../orders/OrdersView.module.css";

type View = "vip" | "all";

/**
 * Orders still waiting to ship, oldest first, and who is waiting for each.
 *
 * VIPs by default — the customers the shop has said it cares about most — with
 * a switch to every unfulfilled order, which is where a marketplace order shows
 * up (a marketplace buyer can never be a VIP: they are a new customer record
 * per order). Three days or more is red, the same line the dispatch figures
 * above are held to.
 *
 * THE RING ON THE NAME is the Orders page's: an open ticket on that order, in
 * its queue band's colour. No ring says nothing — a ticket that never quoted
 * the order number leaves none.
 */
export function OpenOrders({ orders, vipRuleSet }: { orders: OpenOrder[]; vipRuleSet: boolean }) {
  const tr = useT();
  const locale = useLocale();
  const { euros } = useFormat();
  const VIEWS: { id: View; label: string }[] = [
    { id: "vip", label: tr("insights.fulfilment.open.vip") },
    { id: "all", label: tr("insights.fulfilment.open.all") },
  ];
  const [view, setView] = useState<View>("vip");
  const rows = view === "vip" ? orders.filter((o) => o.isVip) : orders;
  const late = rows.filter((o) => o.late).length;
  const vipCount = orders.filter((o) => o.isVip).length;
  const ringed = rows.some((o) => o.ticket);

  return (
    <div className={styles.wrap}>
      <div className={styles.controls}>
        <Segmented
          options={VIEWS.map((v) => ({
            ...v,
            label: `${v.label} (${v.id === "vip" ? vipCount : orders.length})`,
          }))}
          value={view}
          onChange={setView}
          label={tr("insights.fulfilment.open.which")}
        />
        {late > 0 ? (
          <span className={styles.lateCount}>
            <span className={styles.lateDot} aria-hidden="true" />
            {tr("insights.fulfilment.open.late", { n: late })}
          </span>
        ) : null}
      </div>

      {view === "vip" && !vipRuleSet ? (
        <p className={styles.empty}>
          {tr("insights.fulfilment.open.noRule")} <Link href="/insights/customers">{tr("insights.fulfilment.open.setOne")}</Link>
          {tr("insights.fulfilment.open.orSwitch")}
        </p>
      ) : rows.length === 0 ? (
        <p className={styles.empty}>
          {view === "vip" ? tr("insights.fulfilment.open.noVip") : tr("insights.fulfilment.open.allShipped")}
        </p>
      ) : (
        <div className={t.wrap}>
          <table className={t.table}>
            <thead>
              <tr>
                <th scope="col">{tr("insights.fulfilment.open.customer")}</th>
                <th scope="col">{tr("tickets.panels.row.email")}</th>
                <th scope="col">{tr("insights.fulfilment.open.provenance")}</th>
                <th scope="col">{tr("insights.sales.mix.orderShort")}</th>
                <th scope="col" className={t.n}>{tr("insights.fulfilment.open.size")}</th>
                <th scope="col">{tr("insights.fulfilment.open.placed")}</th>
                <th scope="col" className={t.n}>{tr("insights.fulfilment.open.daysWaiting")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.orderId} className={o.late ? styles.lateRow : undefined}>
                  <th scope="row">
                    <span className={ordersCss.ring} data-band={o.ticket?.band} title={ticketNote(o, tr)}>
                      {o.customerName ?? <span className={t.muted}>{tr("insights.fulfilment.open.noName")}</span>}
                      {o.ticket ? <span className={ordersCss.srOnly}>{ticketNote(o, tr)}</span> : null}
                    </span>
                    {o.isVip ? <span className={styles.vip}>VIP</span> : null}
                  </th>
                  <td>{o.email ? <span className={styles.email}>{o.email}</span> : <span className={t.muted}>—</span>}</td>
                  <td>
                    {o.platformLabel}
                    {o.channelLabel && o.channelLabel !== o.platformLabel ? (
                      <span className={t.sub}>{o.channelLabel}</span>
                    ) : null}
                  </td>
                  <td>
                    {o.adminUrl ? (
                      <a href={o.adminUrl} target="_blank" rel="noreferrer" title={tr("insights.fulfilment.open.openAdmin")}>
                        {o.name}
                      </a>
                    ) : (
                      o.name
                    )}
                    <span className={t.sub}>{statusLabel(o.status, tr)}</span>
                  </td>
                  <td className={t.n}>
                    {euros(o.total, { cents: true })}
                    <span className={t.sub}>
                      {tr("insights.fulfilment.open.items", { count: o.units })}
                    </span>
                  </td>
                  <td>{o.placedAt ? formatDayL(new Date(o.placedAt), locale) : o.placedLabel}</td>
                  <td className={t.n}>
                    <span className={o.late ? styles.lateDays : styles.days}>
                      {tr("insights.fulfilment.open.days", { count: o.daysWaiting })}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {ringed ? (
        <p className={ordersCss.legend}>
          <span className={ordersCss.legendSwatches} aria-hidden="true">
            <span className={ordersCss.ring} data-band="high" />
            <span className={ordersCss.ring} data-band="medium" />
            <span className={ordersCss.ring} data-band="low" />
          </span>
          {tr("orders.ringLegend")}
        </p>
      ) : null}
    </div>
  );
}

/** The ring's tooltip and screen-reader text, as on the Orders page. */
function ticketNote(o: OpenOrder, tr: (key: string, params?: Record<string, string | number>) => string): string | undefined {
  if (!o.ticket) return undefined;
  return tr("orders.ticketNote", { count: o.ticket.openTickets, band: tr(`tickets.view.priority.${o.ticket.band}`).toLowerCase() });
}

function statusLabel(status: string, tr: (key: string) => string): string {
  const key = `insights.fulfilment.open.status.${status.toLowerCase()}`;
  const known = tr(key);
  if (known !== key) return known;
  const words = status.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}


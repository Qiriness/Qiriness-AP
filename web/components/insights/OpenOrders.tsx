"use client";

import { useState } from "react";
import Link from "next/link";
import type { OpenOrder } from "@/lib/types";
import { euros } from "@/lib/insights-format";
import { Segmented } from "./Segmented";
import t from "./tables.module.css";
import styles from "./OpenOrders.module.css";

type View = "vip" | "all";

const VIEWS: { id: View; label: string }[] = [
  { id: "vip", label: "VIP customers" },
  { id: "all", label: "All unfulfilled" },
];

/**
 * Orders still waiting to ship, oldest first, and who is waiting for each.
 *
 * VIPs by default — the customers the shop has said it cares about most — with
 * a switch to every unfulfilled order, which is where a marketplace order shows
 * up (a marketplace buyer can never be a VIP: they are a new customer record
 * per order). Three days or more is red, the same line the dispatch figures
 * above are held to.
 */
export function OpenOrders({ orders, vipRuleSet }: { orders: OpenOrder[]; vipRuleSet: boolean }) {
  const [view, setView] = useState<View>("vip");
  const rows = view === "vip" ? orders.filter((o) => o.isVip) : orders;
  const late = rows.filter((o) => o.late).length;
  const vipCount = orders.filter((o) => o.isVip).length;

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
          label="Which orders"
        />
        {late > 0 ? (
          <span className={styles.lateCount}>
            <span className={styles.lateDot} aria-hidden="true" />
            {late} waiting 3 days or more
          </span>
        ) : null}
      </div>

      {view === "vip" && !vipRuleSet ? (
        <p className={styles.empty}>
          No VIP rule is set, so nobody is a VIP yet. <Link href="/insights/customers">Set one on Customers</Link>, or
          switch to all unfulfilled orders.
        </p>
      ) : rows.length === 0 ? (
        <p className={styles.empty}>
          {view === "vip" ? "No VIP has an order waiting to ship." : "Every order has shipped."}
        </p>
      ) : (
        <div className={t.wrap}>
          <table className={t.table}>
            <thead>
              <tr>
                <th scope="col">Customer</th>
                <th scope="col">Email</th>
                <th scope="col">Provenance</th>
                <th scope="col">Order</th>
                <th scope="col" className={t.n}>Order size</th>
                <th scope="col">Placed</th>
                <th scope="col" className={t.n}>Days waiting</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.orderId} className={o.late ? styles.lateRow : undefined}>
                  <th scope="row">
                    {o.customerName ?? <span className={t.muted}>No name on file</span>}
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
                      <a href={o.adminUrl} target="_blank" rel="noreferrer" title="Open in Shopify admin">
                        {o.name}
                      </a>
                    ) : (
                      o.name
                    )}
                    <span className={t.sub}>{statusLabel(o.status)}</span>
                  </td>
                  <td className={t.n}>
                    {euros(o.total, { cents: true })}
                    <span className={t.sub}>
                      {o.units} {o.units === 1 ? "item" : "items"}
                    </span>
                  </td>
                  <td>{o.placedLabel}</td>
                  <td className={t.n}>
                    <span className={o.late ? styles.lateDays : styles.days}>
                      {o.daysWaiting} {o.daysWaiting === 1 ? "day" : "days"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function statusLabel(status: string): string {
  const words = status.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}


"use client";

import { useMemo, useState } from "react";
import type { PairGroup } from "@/lib/types";
import { useFormat, useLocale, useT } from "@/lib/i18n/client";
import { countryName } from "@/lib/insights-labels";
import { GroupSelect, Segmented } from "./Segmented";
import t from "./tables.module.css";
import styles from "./ProductPairs.module.css";

type Dimension = "global" | "country";
type Metric = "orders" | "revenue";

const TOP = 10;

/**
 * The products bought together most often. A pair counts once for every order
 * holding both, whatever else was in the basket; revenue is what the two lines
 * brought in together. Ranked in SQL both ways, so switching metric is a re-sort
 * of what is already here.
 */
export function ProductPairs({ groups }: { groups: PairGroup[] }) {
  const tr = useT();
  const locale = useLocale();
  const { euros, integer } = useFormat();
  const DIMENSIONS: { id: Dimension; label: string }[] = [
    { id: "global", label: tr("insights.sales.global") },
    { id: "country", label: tr("insights.sales.byCountryTab") },
  ];
  const METRICS: { id: Metric; label: string }[] = [
    { id: "orders", label: tr("insights.overview.orders") },
    { id: "revenue", label: tr("insights.sales.revenue") },
  ];
  const [dimension, setDimension] = useState<Dimension>("global");
  const [metric, setMetric] = useState<Metric>("orders");
  const [countryKey, setCountryKey] = useState<string | null>(null);

  const countries = groups.filter((g) => g.key !== "all");
  const country = countries.find((g) => g.key === countryKey) ?? countries[0] ?? null;
  const group = dimension === "global" ? groups.find((g) => g.key === "all") ?? null : country;

  const rows = useMemo(() => {
    if (!group) return [];
    const rank = (p: (typeof group.pairs)[number]) => (metric === "orders" ? p.rankByOrders : p.rankByRevenue);
    return [...group.pairs].sort((a, b) => rank(a) - rank(b)).slice(0, TOP);
  }, [group, metric]);

  return (
    <div className={styles.wrap}>
      <div className={styles.controls}>
        <Segmented options={DIMENSIONS} value={dimension} onChange={setDimension} label={tr("insights.sales.groupPairs")} />
        {dimension === "country" && countries.length > 0 ? (
          <GroupSelect label={tr("insights.sales.country")} value={country?.key ?? ""} onChange={setCountryKey} groups={countries.map((g) => ({ ...g, label: countryName(g.key, g.label, locale) }))} />
        ) : null}
        <span className={styles.spacer} />
        <Segmented options={METRICS} value={metric} onChange={setMetric} label={tr("insights.sales.rankBy")} />
      </div>

      {rows.length === 0 ? (
        <p className={styles.empty}>{tr("insights.sales.noPairs")}</p>
      ) : (
        <div className={styles.tableBox}>
          {/* Fixed layout at the card's own width: the pair column takes what is
              left after the three narrow ones, so the table can never outgrow
              the card and scroll sideways. */}
          <table className={`${t.table} ${styles.fit}`}>
            <colgroup>
              <col className={styles.colRank} />
              <col />
              <col className={styles.colOrders} />
              <col className={styles.colRevenue} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col" className={t.n}>#</th>
                <th scope="col">{tr("insights.sales.boughtTogether")}</th>
                <th scope="col" className={t.n}>{tr("insights.overview.orders")}</th>
                <th scope="col" className={t.n} title={tr("insights.sales.pairRevenueHint")}>
                  {tr("insights.sales.revenue")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((pair, i) => (
                <tr key={`${pair.a.id}-${pair.b.id}`}>
                  <td className={`${t.n} ${t.muted}`}>{i + 1}</td>
                  {/* Two stacked lines, one product each: a long French product
                      name keeps a line to itself instead of pushing the row
                      wide. Each line shortens with an ellipsis; the full name
                      is its tooltip. */}
                  <th scope="row">
                    <span className={styles.pair}>
                      <span className={styles.product} title={pair.a.title}>
                        {pair.a.title}
                      </span>
                      <span className={styles.productLine}>
                        <span className={styles.plus} aria-label={tr("insights.sales.and")}>
                          +
                        </span>
                        <span className={styles.product} title={pair.b.title}>
                          {pair.b.title}
                        </span>
                      </span>
                    </span>
                  </th>
                  <td className={`${t.n} ${metric === "orders" ? styles.lead : ""}`}>{integer(pair.orders)}</td>
                  <td className={`${t.n} ${metric === "revenue" ? styles.lead : ""}`}>{euros(pair.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

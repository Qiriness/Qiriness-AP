"use client";

import { useMemo, useState } from "react";
import type { ProductGroup, SalesPanel } from "@/lib/types";
import { euros } from "@/lib/insights-format";
import { GroupSelect, Segmented } from "./Segmented";
import styles from "./BestProducts.module.css";

type Dimension = "global" | "country";
type Metric = "revenue" | "orders";

const DIMENSIONS: { id: Dimension; label: string }[] = [
  { id: "global", label: "Global" },
  { id: "country", label: "By country" },
];

const METRICS: { id: Metric; label: string }[] = [
  { id: "revenue", label: "Revenue" },
  { id: "orders", label: "Orders" },
];

const TOP = 10;

/**
 * Best-selling products, globally or per country, by revenue or by orders.
 *
 * Client-side only for the switching — every list arrives computed. Country
 * lists are ranked in SQL per metric (country x product is too many rows to
 * ship); the global list arrives whole (one row per product) and is sorted here.
 */
export function BestProducts({ products }: { products: SalesPanel["products"] }) {
  const [dimension, setDimension] = useState<Dimension>("global");
  const [metric, setMetric] = useState<Metric>("revenue");
  const [countryKey, setCountryKey] = useState<string | null>(null);

  const countries = products.byCountry[metric];
  const country = countries.find((g) => g.key === countryKey) ?? countries[0] ?? null;
  const group: ProductGroup | null = dimension === "global" ? products.global : country;

  const ranked = useMemo(() => {
    if (!group) return [];
    return [...group.products]
      .sort((a, b) => (metric === "revenue" ? b.revenue - a.revenue : b.orders - a.orders) || b.revenue - a.revenue)
      .slice(0, TOP);
  }, [group, metric]);

  const max = Math.max(1, ...ranked.map((p) => (metric === "revenue" ? p.revenue : p.orders)));

  return (
    <div className={styles.wrap}>
      <div className={styles.controls}>
        <Segmented options={DIMENSIONS} value={dimension} onChange={setDimension} label="Group products" />
        {dimension === "country" && countries.length > 0 ? (
          <GroupSelect
            label="Country"
            value={country?.key ?? ""}
            onChange={setCountryKey}
            groups={countries.map((g) => ({ key: g.key, label: g.label, hint: `${g.orders.toLocaleString("en-GB")} orders` }))}
          />
        ) : null}
        <span className={styles.spacer} />
        <Segmented options={METRICS} value={metric} onChange={setMetric} label="Rank by" />
      </div>

      {ranked.length === 0 ? (
        <p className={styles.empty}>No paid product line in this range.</p>
      ) : (
        <ol className={styles.list}>
          {ranked.map((p, i) => {
            const value = metric === "revenue" ? p.revenue : p.orders;
            return (
              <li key={p.productId} className={styles.row}>
                <span className={styles.rank}>{i + 1}</span>
                <span className={styles.main}>
                  <span className={styles.title} title={p.title}>
                    {p.title}
                  </span>
                  <span className={styles.track}>
                    <span className={styles.fill} style={{ width: `${((value / max) * 100).toFixed(1)}%` }} />
                  </span>
                </span>
                <span className={styles.figures}>
                  <span className={metric === "revenue" ? styles.lead : styles.second}>{euros(p.revenue)}</span>
                  <span className={metric === "orders" ? styles.lead : styles.second}>
                    {p.orders.toLocaleString("en-GB")} {p.orders === 1 ? "order" : "orders"}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import type { ProductGroup, SalesPanel } from "@/lib/types";
import { SearchIcon } from "@/components/icons";
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

/** A search shows every match, up to this many — past it, the search is too broad to read. */
const MAX_MATCHES = 50;

/**
 * Best-selling products, globally or per country, by revenue or by orders.
 *
 * Client-side only for the switching — every list arrives computed. Country
 * lists are ranked in SQL per metric (country x product is too many rows to
 * ship); the global list arrives whole (one row per product) and is sorted here.
 *
 * SEARCH FILTERS THE RANKING, IT DOES NOT RE-RANK. A match keeps the position it
 * holds in the full list and its bar keeps the full list's scale, so finding a
 * product answers "where does it stand", not just "what did it sell". Matching
 * ignores case and accents: the catalogue is French, and "creme" must find
 * "Crème". The global list is complete, so a miss there is a real miss; a
 * country list holds only its top products, and the empty state says so.
 */
export function BestProducts({ products }: { products: SalesPanel["products"] }) {
  const [dimension, setDimension] = useState<Dimension>("global");
  const [metric, setMetric] = useState<Metric>("revenue");
  const [countryKey, setCountryKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const countries = products.byCountry[metric];
  const country = countries.find((g) => g.key === countryKey) ?? countries[0] ?? null;
  const group: ProductGroup | null = dimension === "global" ? products.global : country;

  const ranked = useMemo(() => {
    if (!group) return [];
    return [...group.products]
      .sort((a, b) => (metric === "revenue" ? b.revenue - a.revenue : b.orders - a.orders) || b.revenue - a.revenue)
      .map((product, i) => ({ product, rank: i + 1 }));
  }, [group, metric]);

  const needle = fold(search);
  const matches = needle ? ranked.filter(({ product }) => fold(product.title).includes(needle)) : ranked;
  const shown = matches.slice(0, needle ? MAX_MATCHES : TOP);

  // The full list's leader sets the scale, searched or not.
  const valueOf = (p: (typeof ranked)[number]["product"]) => (metric === "revenue" ? p.revenue : p.orders);
  const max = Math.max(1, ...ranked.slice(0, 1).map(({ product }) => valueOf(product)));

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
        <div className={styles.search} role="search">
          <SearchIcon size={15} className={styles.searchIcon} />
          <input
            type="search"
            className={styles.searchInput}
            value={search}
            placeholder="Find a product"
            aria-label="Find a product"
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setSearch("");
            }}
          />
        </div>
        <Segmented options={METRICS} value={metric} onChange={setMetric} label="Rank by" />
      </div>

      {needle && matches.length > 0 ? (
        <p className={styles.hint} role="status">
          {matches.length} {matches.length === 1 ? "product matches" : "products match"}
          {matches.length > MAX_MATCHES ? ` — showing the top ${MAX_MATCHES}` : ""}
        </p>
      ) : null}

      {ranked.length === 0 ? (
        <p className={styles.empty}>No paid product line in this range.</p>
      ) : shown.length === 0 ? (
        <p className={styles.empty}>
          {dimension === "global"
            ? `No product matching “${search.trim()}” sold in this range.`
            : `No product matching “${search.trim()}” among the ${ranked.length} best sellers loaded for ${group?.label ?? "this country"}.`}
        </p>
      ) : (
        <ol className={styles.list}>
          {shown.map(({ product: p, rank }) => {
            const value = valueOf(p);
            return (
              <li key={p.productId} className={styles.row}>
                <span className={styles.rank}>{rank}</span>
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

/** Lower case, accents removed, spaces collapsed: "  Crème  Légère" -> "creme legere". */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

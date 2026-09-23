"use client";

import { useMemo, useState } from "react";
import type { ProductGroup, ProductSale, SalesPanel } from "@/lib/types";
import { SearchIcon } from "@/components/icons";
import { euros, foldForSearch as fold } from "@/lib/insights-format";
import { useInsightsFrame } from "./InsightsFrame";
import { GroupSelect, Segmented } from "./Segmented";
import t from "./tables.module.css";
import styles from "./ProductPerformance.module.css";

type Dimension = "global" | "country";
type Metric = "revenue" | "orders" | "growth" | "decline";
type Who = "all" | "vip";

const DIMENSIONS: { id: Dimension; label: string }[] = [
  { id: "global", label: "Global" },
  { id: "country", label: "By country" },
];

const METRICS: { id: Metric; label: string }[] = [
  { id: "revenue", label: "Revenue" },
  { id: "orders", label: "Orders" },
  { id: "growth", label: "Growth" },
  { id: "decline", label: "Declines" },
];

const WHO: { id: Who; label: string }[] = [
  { id: "all", label: "All customers" },
  { id: "vip", label: "VIP only" },
];

const TOP = 10;

/** A search shows every match, up to this many — past it, the search is too broad to read. */
const MAX_MATCHES = 50;

/**
 * Product performance: what each product sold in the range, what it sold one
 * period earlier, and which products moved most in each direction.
 *
 * A TABLE, NOT BARS (2026-09-23, the owner's reference report). Six columns say
 * more than a bar: revenue, the change in euros and per cent, orders and units.
 * The ranking is still the point, so the rank column stays.
 *
 * GROWTH AND DECLINES ARE GLOBAL ONLY, and the tabs disable themselves
 * elsewhere rather than showing a number that cannot be right. A country list
 * holds each country's top few products, ranked in SQL; the same cut one period
 * earlier is a different set of products, so a product that dropped out of it
 * would read as a total collapse. The VIP lists have no previous-period twin at
 * all. Both cases say why instead of going blank.
 *
 * SEARCH FILTERS THE RANKING, IT DOES NOT RE-RANK. A match keeps the position it
 * holds in the full list, so finding a product answers "where does it stand".
 * Matching ignores case and accents: the catalogue is French, and "creme" must
 * find "Crème". The global list is complete, so a miss there is a real miss; a
 * country list holds only its top products, and the empty state says so.
 *
 * VIP ONLY IS A SERVER READ (`?bestVip=1`), unlike the other switches: VIP is
 * the shop's rule in `vip_customers()`, so the lists are re-ranked in SQL over
 * VIP customers' orders rather than filtered here.
 */
export function ProductPerformance({ products, compareLabel }: { products: SalesPanel["products"]; compareLabel: string }) {
  const [dimension, setDimension] = useState<Dimension>("global");
  const [metric, setMetric] = useState<Metric>("revenue");
  const [countryKey, setCountryKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const { navigate } = useInsightsFrame();

  const countryMetric = metric === "orders" ? "orders" : "revenue";
  const countries = products.byCountry[countryMetric];
  const country = countries.find((g) => g.key === countryKey) ?? countries[0] ?? null;
  const group: ProductGroup | null = dimension === "global" ? products.global : country;

  // A comparison exists only where the service filled it in: the global list of
  // all customers. Everywhere else the two movement tabs are disabled.
  const comparable = (group?.products ?? []).some((p) => p.previousRevenue !== null);
  const movement = metric === "growth" || metric === "decline";
  const effective: Metric = movement && !comparable ? "revenue" : metric;

  const ranked = useMemo(() => {
    if (!group) return [];
    const rows = [...group.products];
    const delta = (p: ProductSale) => (p.previousRevenue === null ? 0 : p.revenue - p.previousRevenue);
    if (effective === "growth") {
      return rows
        .filter((p) => p.previousRevenue !== null && delta(p) > 0)
        .sort((a, b) => delta(b) - delta(a))
        .map((product, i) => ({ product, rank: i + 1 }));
    }
    if (effective === "decline") {
      return rows
        .filter((p) => p.previousRevenue !== null && delta(p) < 0)
        .sort((a, b) => delta(a) - delta(b))
        .map((product, i) => ({ product, rank: i + 1 }));
    }
    return rows
      .sort((a, b) => (effective === "orders" ? b.orders - a.orders : b.revenue - a.revenue) || b.revenue - a.revenue)
      .map((product, i) => ({ product, rank: i + 1 }));
  }, [group, effective]);

  const needle = fold(search);
  const matches = needle ? ranked.filter(({ product }) => fold(product.title).includes(needle)) : ranked;
  const shown = matches.slice(0, needle ? MAX_MATCHES : TOP);

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
        <Segmented
          options={WHO}
          value={products.vipOnly ? "vip" : "all"}
          label="Customers"
          onChange={(next) => navigate({ bestVip: next === "vip" ? "1" : null })}
        />
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
        <Segmented
          options={METRICS.map((m) => ({
            ...m,
            label: (m.id === "growth" || m.id === "decline") && !comparable ? `${m.label} —` : m.label,
          }))}
          value={effective}
          onChange={setMetric}
          label="Rank by"
        />
      </div>

      {movement && !comparable ? (
        <p className={styles.hint} role="status">
          {products.vipOnly
            ? "Growth and declines are not compared over VIP customers: the VIP lists have no previous-period twin."
            : "Growth and declines are ranked globally. A country list holds only that country's top products, so the same cut one period earlier would be a different set."}
        </p>
      ) : null}

      {needle && matches.length > 0 ? (
        <p className={styles.hint} role="status">
          {matches.length} {matches.length === 1 ? "product matches" : "products match"}
          {matches.length > MAX_MATCHES ? ` — showing the top ${MAX_MATCHES}` : ""}
        </p>
      ) : null}

      {products.notice ? (
        <p className={styles.empty} role="status">
          {products.notice}
        </p>
      ) : ranked.length === 0 ? (
        <p className={styles.empty}>
          {effective === "growth"
            ? `No product sold more than it did ${compareLabel}.`
            : effective === "decline"
              ? `No product sold less than it did ${compareLabel}.`
              : products.vipOnly
                ? "No VIP customer bought a paid product in this range."
                : "No paid product line in this range."}
        </p>
      ) : shown.length === 0 ? (
        <p className={styles.empty}>
          {dimension === "global"
            ? `No product matching “${search.trim()}” sold in this range.`
            : `No product matching “${search.trim()}” among the ${ranked.length} best sellers loaded for ${group?.label ?? "this country"}.`}
        </p>
      ) : (
        <div className={t.wrap}>
          <table className={t.table}>
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col" className={t.n}>Revenue</th>
                <th scope="col" className={t.n} title={`Change against ${compareLabel}`}>Δ €</th>
                <th scope="col" className={t.n}>Δ %</th>
                <th scope="col" className={t.n}>Orders</th>
                <th scope="col" className={t.n}>Units</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(({ product: p, rank }) => (
                <tr key={p.productId}>
                  <th scope="row">
                    <span className={styles.rank}>{rank}</span>
                    <span className={styles.title} title={p.title}>
                      {p.title}
                    </span>
                  </th>
                  <td className={t.n}>{euros(p.revenue)}</td>
                  <td className={t.n}>
                    <Delta product={p} />
                  </td>
                  <td className={t.n}>
                    <DeltaPercent product={p} />
                  </td>
                  <td className={t.n}>{p.orders.toLocaleString("en-GB")}</td>
                  <td className={t.n}>{p.units.toLocaleString("en-GB")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** The change in euros, or a dash where no period can be compared. */
function Delta({ product }: { product: ProductSale }) {
  if (product.previousRevenue === null) return <span className={t.muted}>—</span>;
  const diff = product.revenue - product.previousRevenue;
  if (Math.abs(diff) < 0.005) return <span className={t.muted}>0 €</span>;
  return (
    <span className={diff > 0 ? styles.up : styles.down}>
      {diff > 0 ? "+" : "−"}
      {euros(Math.abs(diff))}
    </span>
  );
}

/**
 * The same change as a percentage. A product that sold nothing last period has
 * no percentage — every change from zero is infinite — so it reads "new".
 */
function DeltaPercent({ product }: { product: ProductSale }) {
  if (product.previousRevenue === null) return <span className={t.muted}>—</span>;
  if (product.previousRevenue === 0) return <span className={styles.badge}>new</span>;
  const change = ((product.revenue - product.previousRevenue) / product.previousRevenue) * 100;
  if (Math.abs(change) < 0.05) return <span className={t.muted}>0.0%</span>;
  return (
    <span className={change > 0 ? styles.up : styles.down}>
      {change > 0 ? "+" : "−"}
      {Math.abs(change).toFixed(1)}%
    </span>
  );
}

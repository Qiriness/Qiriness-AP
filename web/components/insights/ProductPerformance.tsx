"use client";

import { useMemo, useState } from "react";
import type { ProductGroup, ProductSale, SalesPanel } from "@/lib/types";
import { SearchIcon } from "@/components/icons";
import { useFormat, useLocale, useT } from "@/lib/i18n/client";
import { foldForSearch as fold } from "@/lib/insights-format";
import { countryName } from "@/lib/insights-labels";
import { useInsightsFrame } from "./InsightsFrame";
import { GroupSelect, Segmented } from "./Segmented";
import t from "./tables.module.css";
import styles from "./ProductPerformance.module.css";

type Dimension = "global" | "country";
type Metric = "revenue" | "orders" | "growth" | "decline";
type Who = "all" | "vip";


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
  const tr = useT();
  const locale = useLocale();
  const { euros, integer, percentOf } = useFormat();
  const DIMENSIONS: { id: Dimension; label: string }[] = [
    { id: "global", label: tr("insights.sales.global") },
    { id: "country", label: tr("insights.sales.byCountryTab") },
  ];
  const METRICS: { id: Metric; label: string }[] = [
    { id: "revenue", label: tr("insights.sales.revenue") },
    { id: "orders", label: tr("insights.overview.orders") },
    { id: "growth", label: tr("insights.sales.growth") },
    { id: "decline", label: tr("insights.sales.declines") },
  ];
  const WHO: { id: Who; label: string }[] = [
    { id: "all", label: tr("insights.sales.allCustomers") },
    { id: "vip", label: tr("insights.sales.vipOnly") },
  ];
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
        <Segmented options={DIMENSIONS} value={dimension} onChange={setDimension} label={tr("insights.sales.groupProducts")} />
        {dimension === "country" && countries.length > 0 ? (
          <GroupSelect
            label={tr("insights.sales.country")}
            value={country?.key ?? ""}
            onChange={setCountryKey}
            groups={countries.map((g) => ({ key: g.key, label: countryName(g.key, g.label, locale), hint: tr("insights.sales.ordersCount", { count: g.orders }) }))}
          />
        ) : null}
        <Segmented
          options={WHO}
          value={products.vipOnly ? "vip" : "all"}
          label={tr("insights.sales.customers")}
          onChange={(next) => navigate({ bestVip: next === "vip" ? "1" : null })}
        />
        <span className={styles.spacer} />
        <div className={styles.search} role="search">
          <SearchIcon size={15} className={styles.searchIcon} />
          <input
            type="search"
            className={styles.searchInput}
            value={search}
            placeholder={tr("insights.sales.findProduct")}
            aria-label={tr("insights.sales.findProduct")}
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
          label={tr("insights.sales.rankBy")}
        />
      </div>

      {movement && !comparable ? (
        <p className={styles.hint} role="status">
          {products.vipOnly
            ? tr("insights.sales.movementVip")
            : tr("insights.sales.movementCountry")}
        </p>
      ) : null}

      {needle && matches.length > 0 ? (
        <p className={styles.hint} role="status">
          {tr("insights.sales.matches", { count: matches.length })}
          {matches.length > MAX_MATCHES ? ` — ${tr("insights.sales.showingTop", { n: MAX_MATCHES })}` : ""}
        </p>
      ) : null}

      {products.notice ? (
        <p className={styles.empty} role="status">
          {tr(products.notice)}
        </p>
      ) : ranked.length === 0 ? (
        <p className={styles.empty}>
          {effective === "growth"
            ? tr("insights.sales.noGrowth", { label: compareLabel })
            : effective === "decline"
              ? tr("insights.sales.noDecline", { label: compareLabel })
              : products.vipOnly
                ? tr("insights.sales.noVipLine")
                : tr("insights.sales.noPaidLine")}
        </p>
      ) : shown.length === 0 ? (
        <p className={styles.empty}>
          {dimension === "global"
            ? tr("insights.sales.noMatchGlobal", { query: search.trim() })
            : tr("insights.sales.noMatchCountry", { query: search.trim(), n: ranked.length, where: group ? countryName(group.key, group.label, locale) : tr("insights.sales.thisCountry") })}
        </p>
      ) : (
        <div className={t.wrap}>
          <table className={t.table}>
            <thead>
              <tr>
                <th scope="col">{tr("insights.inventory.product")}</th>
                <th scope="col" className={t.n}>{tr("insights.sales.revenue")}</th>
                <th scope="col" className={t.n} title={tr("insights.sales.changeAgainst", { label: compareLabel })}>Δ €</th>
                <th scope="col" className={t.n}>Δ %</th>
                <th scope="col" className={t.n}>{tr("insights.overview.orders")}</th>
                <th scope="col" className={t.n}>{tr("insights.sales.units")}</th>
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
                  <td className={t.n}>{integer(p.orders)}</td>
                  <td className={t.n}>{integer(p.units)}</td>
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
  const { euros } = useFormat();
  if (product.previousRevenue === null) return <span className={t.muted}>—</span>;
  const diff = product.revenue - product.previousRevenue;
  if (Math.abs(diff) < 0.005) return <span className={t.muted}>{euros(0)}</span>;
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
  const tr = useT();
  const { percentOf } = useFormat();
  if (product.previousRevenue === null) return <span className={t.muted}>—</span>;
  if (product.previousRevenue === 0) return <span className={styles.badge}>{tr("insights.sales.new")}</span>;
  const change = ((product.revenue - product.previousRevenue) / product.previousRevenue) * 100;
  if (Math.abs(change) < 0.05) return <span className={t.muted}>{percentOf(0, 1)}</span>;
  return (
    <span className={change > 0 ? styles.up : styles.down}>
      {change > 0 ? "+" : "−"}
      {percentOf(Math.abs(change), 1)}
    </span>
  );
}

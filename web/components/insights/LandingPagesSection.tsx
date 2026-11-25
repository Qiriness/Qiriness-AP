"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { ChannelGroup, FunnelCounts, LandingPage, WebsitePerformanceData } from "@/lib/marketing-types";
import { useFormat, useT } from "@/lib/i18n/client";
import { DataTable, InfoTip, typeName, type Column } from "./MarketingKit";
import { Segmented } from "./Segmented";
import t from "./tables.module.css";
import x from "./WebsiteExplorer.module.css";
import styles from "./LandingPagesSection.module.css";

type Tab = "all" | "Product" | "Collection" | "Homepage" | "Blog Article" | "other";
const NAMED: Tab[] = ["Product", "Collection", "Homepage", "Blog Article"];

/** A cell of the matrix needs this many sessions before its rate is coloured. */
const MIN_CELL_SESSIONS = 30;
const MATRIX_PAGES = 15;
const MATRIX_GROUPS: ChannelGroup[] = ["paid_search", "paid_social", "email", "organic_search", "organic_social", "direct", "referral"];

const rate = (c: FunnelCounts, field: keyof FunnelCounts) => (c.sessions > 0 ? (c[field] / c.sessions) * 100 : null);

/**
 * Landing pages: sessions that STARTED on a page, never page views. One table
 * with a tab per page type; collections carry their category, products their
 * price band. A row opens onto its funnel, channels and devices.
 */
export function LandingPagesSection({ data, compareLabel }: { data: WebsitePerformanceData; compareLabel: string }) {
  const tr = useT();
  const [tab, setTab] = useState<Tab>("all");
  const [category, setCategory] = useState<string | null>(null);
  const total = data.pages.reduce((s, p) => s + p.sessions, 0);
  const pages = useMemo(
    () =>
      data.pages.filter((p) =>
        tab === "all" ? true : tab === "other" ? !NAMED.includes(p.type as Tab) : p.type === tab && (tab !== "Collection" || !category || p.category === category)
      ),
    [data.pages, tab, category]
  );
  const categories = [...new Set(data.pages.filter((p) => p.type === "Collection").map((p) => p.category ?? "other"))];

  return (
    <>
      <section className={x.card}>
        <h2 className={x.title}>
          {tr("insights.mkt.landing.title")}
          <InfoTip text={tr("insights.mkt.landing.tip")} />
        </h2>
        <div className={styles.controls}>
          <Segmented
            options={(["all", ...NAMED, "other"] as Tab[]).map((id) => ({ id, label: id === "all" ? tr("insights.mkt.funnel.all") : id === "other" ? tr("insights.mkt.landing.otherTypes") : typeName(id, tr) }))}
            value={tab}
            onChange={(v) => {
              setTab(v);
              setCategory(null);
            }}
            label={tr("insights.mkt.funnel.landingType")}
          />
          {tab === "Collection" ? (
            <Segmented
              options={[{ id: "", label: tr("insights.mkt.funnel.all") }, ...categories.map((c) => ({ id: c, label: tr(`insights.mkt.category.${c}`) }))]}
              value={category ?? ""}
              onChange={(v) => setCategory(v || null)}
              label={tr("insights.mkt.landing.category")}
            />
          ) : null}
        </div>
        <PagesTable pages={pages} total={total} tab={tab} storefrontUrl={data.storefrontUrl} compareLabel={compareLabel} />
        <p className={x.note}>{tr(tab === "Collection" ? "insights.mkt.landing.noteCollections" : tab === "Product" ? "insights.mkt.landing.noteProducts" : "insights.mkt.landing.note")}</p>
      </section>
      <section className={x.card}>
        <h2 className={x.title}>
          {tr("insights.mkt.matrix.title")}
          <InfoTip text={tr("insights.mkt.matrix.tip")} />
        </h2>
        <ChannelMatrix pages={pages.length ? pages : data.pages} />
      </section>
    </>
  );
}

function PagesTable({ pages, total, tab, storefrontUrl, compareLabel }: { pages: LandingPage[]; total: number; tab: Tab; storefrontUrl: string | null; compareLabel: string }) {
  const tr = useT();
  const { integer, percentOf, decimal } = useFormat();
  const dash = <span className={t.muted}>—</span>;
  const pct = (v: number | null, d = 1) => (v === null ? dash : percentOf(v, d));
  const prevCvr = (p: LandingPage) => (p.previous && p.previous.sessions > 0 ? (p.previous.convertedSessions / p.previous.sessions) * 100 : null);
  const sessionsChange = (p: LandingPage) => (p.previous && p.previous.sessions > 0 ? ((p.sessions - p.previous.sessions) / p.previous.sessions) * 100 : null);
  const col = (id: string, sort: (r: LandingPage) => number | string | null, render: (r: LandingPage) => ReactNode, numeric = true): Column<LandingPage> => ({
    id,
    label: tr(`insights.mkt.landing.col.${id}`),
    tip: tr(`insights.mkt.landing.colTip.${id}`),
    numeric,
    sort,
    render,
  });
  const columns: Column<LandingPage>[] = [
    {
      id: "page",
      label: tr("insights.mkt.landing.col.page"),
      sort: (p) => p.title ?? p.path,
      render: (p) => (
        <>
          <span className={styles.pageName}>{p.title ?? p.path}</span>
          <span className={t.sub}>
            {storefrontUrl ? (
              <a href={`${storefrontUrl.replace(/\/$/, "")}${p.path}`} target="_blank" rel="noreferrer">
                {p.path} ↗
              </a>
            ) : (
              p.path
            )}
          </span>
        </>
      ),
    },
    ...(tab === "all" || tab === "other" ? [col("type", (p) => p.type, (p) => typeName(p.type, tr), false)] : []),
    ...(tab === "Collection" ? [col("category", (p) => p.category, (p) => tr(`insights.mkt.category.${p.category ?? "other"}`), false)] : []),
    ...(tab === "Product" ? [col("priceBand", (p) => p.priceBand, (p) => (p.priceBand ? tr(`insights.mkt.band.${p.priceBand}`) : dash), false)] : []),
    col("sessions", (p) => p.sessions, (p) => integer(p.sessions)),
    col("share", (p) => (total > 0 ? p.sessions / total : null), (p) => (total > 0 ? percentOf((p.sessions / total) * 100, 1) : dash)),
    col("visitors", (p) => p.visitors, (p) => (p.visitors === null ? dash : integer(p.visitors))),
    col("bounce", (p) => p.bounceRate, (p) => pct(p.bounceRate, 0)),
    col("cart", (p) => p.cartRate, (p) => pct(p.cartRate)),
    col("checkout", (p) => p.checkoutRate, (p) => pct(p.checkoutRate)),
    col("converted", (p) => p.convertedSessions, (p) => integer(p.convertedSessions)),
    col("cvr", (p) => p.conversionRate, (p) => pct(p.conversionRate, 2)),
    col("sessionsChange", sessionsChange, (p) => {
      const c = sessionsChange(p);
      return c === null ? (p.previous ? <span className={t.muted}>{tr("insights.mkt.landing.new")}</span> : dash) : `${c >= 0 ? "+" : "−"}${percentOf(Math.abs(c), 0)}`;
    }),
    col("cvrChange", (p) => (p.conversionRate !== null && prevCvr(p) !== null ? p.conversionRate - prevCvr(p)! : null), (p) => {
      const b = prevCvr(p);
      return p.conversionRate === null || b === null ? dash : <span title={compareLabel}>{`${p.conversionRate - b >= 0 ? "+" : "−"}${decimal(Math.abs(p.conversionRate - b), 2)} ${tr("insights.mkt.funnel.pts")}`}</span>;
    }),
  ];
  return (
    <DataTable
      rows={pages}
      columns={columns}
      rowKey={(p) => p.path}
      initialSort={{ id: "sessions", desc: true }}
      search={(p) => `${p.title ?? ""} ${p.path}`}
      searchPlaceholder={tr("insights.mkt.landing.search")}
      expand={(p) => <PageDetail page={p} />}
      limit={25}
      caption={tr("insights.mkt.landing.title")}
    />
  );
}

/** The expanded row: the page's own funnel, its channels and its devices. */
function PageDetail({ page }: { page: LandingPage }) {
  const tr = useT();
  const { integer, percentOf } = useFormat();
  const steps: [string, number][] = [
    ["sessions", page.sessions],
    ["cart", page.cartSessions],
    ["checkout", page.checkoutSessions],
    ["purchase", page.convertedSessions],
  ];
  const breakdown = (rows: { key: string; counts: FunnelCounts }[], label: (k: string) => string) => (
    <table className={t.table}>
      <thead>
        <tr>
          <th scope="col" />
          <th scope="col" className={t.n}>{tr("insights.mkt.slice.sessions")}</th>
          <th scope="col" className={t.n}>{tr("insights.mkt.slice.cart")}</th>
          <th scope="col" className={t.n}>{tr("insights.mkt.slice.cvr")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <th scope="row">
              {label(r.key)}
              {r.counts.sessions < MIN_CELL_SESSIONS ? <span className={t.sub}>{tr("insights.mkt.slice.lowSample")}</span> : null}
            </th>
            <td className={t.n}>{integer(r.counts.sessions)}</td>
            <td className={t.n}>{rate(r.counts, "cartSessions") === null ? "—" : percentOf(rate(r.counts, "cartSessions")!, 1)}</td>
            <td className={t.n}>{rate(r.counts, "convertedSessions") === null ? "—" : percentOf(rate(r.counts, "convertedSessions")!, 2)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <div className={styles.detail}>
      <div>
        <h3>{tr("insights.mkt.landing.detail.funnel")}</h3>
        <ol className={styles.miniFunnel}>
          {steps.map(([key, value]) => (
            <li key={key}>
              <span>{tr(`insights.mkt.funnel.step.${key}`)}</span>
              <span className={styles.miniBar}>
                <i style={{ width: page.sessions > 0 ? `${Math.max(1, (value / page.sessions) * 100).toFixed(1)}%` : "0%" }} />
              </span>
              <b>{integer(value)}</b>
            </li>
          ))}
        </ol>
      </div>
      <div>
        <h3>{tr("insights.mkt.landing.detail.channels")}</h3>
        {breakdown(page.byGroup, (k) => tr(`insights.mkt.group.${k}`))}
      </div>
      <div>
        <h3>{tr("insights.mkt.landing.detail.devices")}</h3>
        {breakdown(page.byDevice, (k) => tr(`insights.mkt.device.${k}`))}
      </div>
      <p className={styles.detailNote}>{tr("insights.mkt.landing.detail.missing")}</p>
    </div>
  );
}

type MatrixMetric = "cvr" | "cart" | "sessions";

/**
 * The busiest pages against the channels that sent them, one metric at a
 * time. A cell is coloured against the page's own rate across all channels —
 * green better, amber worse — and only with enough sessions; a thin cell is
 * shown grey. It points at a page or a channel to look at; it proves nothing.
 */
function ChannelMatrix({ pages }: { pages: LandingPage[] }) {
  const tr = useT();
  const { integer, percentOf } = useFormat();
  const [metric, setMetric] = useState<MatrixMetric>("cvr");
  const top = [...pages].sort((a, b) => b.sessions - a.sessions).slice(0, MATRIX_PAGES);
  const field: keyof FunnelCounts = metric === "cart" ? "cartSessions" : "convertedSessions";
  return (
    <>
      <div className={styles.controls}>
        <Segmented
          options={(["cvr", "cart", "sessions"] as MatrixMetric[]).map((id) => ({ id, label: tr(`insights.mkt.matrix.metric.${id}`) }))}
          value={metric}
          onChange={setMetric}
          label={tr("insights.mkt.matrix.title")}
        />
      </div>
      <div className={t.wrap}>
        <table className={`${t.table} ${styles.matrix}`}>
          <thead>
            <tr>
              <th scope="col">{tr("insights.mkt.landing.col.page")}</th>
              {MATRIX_GROUPS.map((g) => (
                <th key={g} scope="col" className={t.n}>
                  {tr(`insights.mkt.group.${g}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {top.map((page) => {
              const overall = page.sessions > 0 ? (page[field] / page.sessions) * 100 : null;
              const byGroup = new Map(page.byGroup.map((g) => [g.key, g.counts]));
              return (
                <tr key={page.path}>
                  <th scope="row" className={styles.pageName} title={page.path}>
                    {page.title ?? page.path}
                  </th>
                  {MATRIX_GROUPS.map((g) => {
                    const c = byGroup.get(g);
                    if (!c || c.sessions === 0) return <td key={g} className={`${t.n} ${t.muted}`}>—</td>;
                    if (metric === "sessions") return <td key={g} className={t.n}>{integer(c.sessions)}</td>;
                    const r = rate(c, field)!;
                    const thin = c.sessions < MIN_CELL_SESSIONS;
                    const tone = thin || overall === null ? "thin" : r >= overall * 1.25 ? "good" : r <= overall * 0.75 ? "bad" : "flat";
                    return (
                      <td key={g} className={`${t.n} ${styles[`cell_${tone}`]}`} title={tr("insights.mkt.matrix.cell", { n: integer(c.sessions) })}>
                        {percentOf(r, metric === "cvr" ? 2 : 1)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className={x.note}>{tr("insights.mkt.matrix.note", { n: MIN_CELL_SESSIONS })}</p>
    </>
  );
}

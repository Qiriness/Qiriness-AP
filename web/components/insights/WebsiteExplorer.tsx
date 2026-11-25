"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { ChannelGroup, FunnelCounts, TrafficRow, WebsitePerformanceData } from "@/lib/marketing-types";
import { useFormat, useT } from "@/lib/i18n/client";
import { foldTraffic, funnelOf, funnelSteps, rates } from "../../../scripts/lib/funnel-math.mjs";
import { useInsightsFrame } from "./InsightsFrame";
import { DataTable, InfoTip, typeName, type Column } from "./MarketingKit";
import { LandingPagesSection } from "./LandingPagesSection";
import { OpportunitiesTable } from "./OpportunitiesTable";
import t from "./tables.module.css";
import styles from "./WebsiteExplorer.module.css";

type Filter = { device: string | null; group: ChannelGroup | null; landingType: string | null };

/** Below this many sessions a slice's rate is not compared with another's. */
const MIN_COMPARE_SESSIONS = 100;

/**
 * The Funnel & Website tab. Device, channel and landing type filter in the
 * browser — the server sent the traffic cut once — and compose: mobile x
 * paid social x product pages is one click each. Country is a query, so it
 * goes through the URL.
 */
export function WebsiteExplorer({ data, compareLabel }: { data: WebsitePerformanceData; compareLabel: string }) {
  const tr = useT();
  const { navigate } = useInsightsFrame();
  const [filter, setFilter] = useState<Filter>({ device: null, group: null, landingType: null });
  const set = (patch: Partial<Filter>) => setFilter((f) => ({ ...f, ...patch }));

  const options = useMemo(() => {
    const total = (field: keyof TrafficRow) =>
      [...(foldTraffic(data.traffic, field) as Map<string, FunnelCounts>)].sort((a, b) => b[1].sessions - a[1].sessions).map(([k]) => k);
    return { devices: total("device"), groups: total("group") as ChannelGroup[], types: total("landingType") };
  }, [data.traffic]);

  return (
    <>
      <section className={styles.filters} aria-label={tr("insights.mkt.funnel.filters")}>
        <Select label={tr("insights.mkt.funnel.device")} value={filter.device} onChange={(v) => set({ device: v })} options={options.devices.map((d) => ({ id: d, label: tr(`insights.mkt.device.${d}`) }))} />
        <Select label={tr("insights.mkt.funnel.channel")} value={filter.group} onChange={(v) => set({ group: v as ChannelGroup | null })} options={options.groups.map((g) => ({ id: g, label: tr(`insights.mkt.group.${g}`) }))} />
        <Select label={tr("insights.mkt.funnel.landingType")} value={filter.landingType} onChange={(v) => set({ landingType: v })} options={options.types.map((x) => ({ id: x, label: typeName(x, tr) }))} />
        <Select
          label={tr("insights.mkt.funnel.country")}
          value={data.country}
          onChange={(v) => navigate({ country: v })}
          options={[...new Set([...(data.country ? [data.country] : []), ...data.countries])].map((c) => ({ id: c, label: c }))}
        />
        {filter.device || filter.group || filter.landingType ? (
          <button type="button" className={styles.reset} onClick={() => setFilter({ device: null, group: null, landingType: null })}>
            {tr("insights.mkt.funnel.reset")}
          </button>
        ) : null}
      </section>

      <div className={styles.grid2}>
        <FunnelCard data={data} filter={filter} compareLabel={compareLabel} />
        <CheckoutCard data={data} filter={filter} />
      </div>

      <div className={styles.grid2}>
        <section className={styles.card}>
          <h2 className={styles.title}>{tr("insights.mkt.device.title")}</h2>
          <SliceTable rows={data.traffic} field="device" filter={{ ...filter, device: null }} label={(k) => tr(`insights.mkt.device.${k}`)} flagGaps />
        </section>
        <section className={styles.card}>
          <h2 className={styles.title}>{tr("insights.mkt.funnel.byChannel")}</h2>
          <SliceTable rows={data.traffic} field="group" filter={{ ...filter, group: null }} label={(k) => tr(`insights.mkt.group.${k}`)} />
        </section>
      </div>

      <section className={styles.card}>
        <h2 className={styles.title}>
          {tr("insights.mkt.landing.overview")}
          <InfoTip text={tr("insights.mkt.landing.overviewTip")} />
        </h2>
        <SliceTable rows={data.traffic} field="landingType" filter={{ ...filter, landingType: null }} label={(k) => typeName(k, tr)} previous={data.previousTraffic} compareLabel={compareLabel} />
      </section>

      <LandingPagesSection data={data} compareLabel={compareLabel} />

      <section className={styles.card}>
        <h2 className={styles.title}>
          {tr("insights.mkt.opps.title")}
          <InfoTip text={tr("insights.mkt.opps.tip")} />
        </h2>
        <OpportunitiesTable data={data} />
      </section>
    </>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string | null; onChange: (v: string | null) => void; options: { id: string; label: string }[] }) {
  const tr = useT();
  return (
    <label className={styles.select}>
      <span>{label}</span>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">{tr("insights.mkt.funnel.all")}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The four sequential session steps for the filtered traffic, with the period before. */
function FunnelCard({ data, filter, compareLabel }: { data: WebsitePerformanceData; filter: Filter; compareLabel: string }) {
  const tr = useT();
  const { integer, percentOf, decimal } = useFormat();
  const now = funnelOf(data.traffic, filter) as FunnelCounts;
  const before = data.previousTraffic ? (funnelOf(data.previousTraffic, filter) as FunnelCounts) : null;
  const steps = funnelSteps(now) as { key: string; value: number; ofEntry: number | null; ofPrevious: number | null; dropOff: number | null }[];
  const cvr = rates(now).conversionRate as number | null;
  const cvrBefore = before && before.sessions > 0 ? (rates(before).conversionRate as number | null) : null;
  return (
    <section className={styles.card}>
      <h2 className={styles.title}>
        {tr("insights.mkt.funnel.title")}
        <InfoTip text={tr("insights.mkt.funnel.tip")} />
      </h2>
      <div className={styles.funnel}>
        {steps.map((step) => (
          <div key={step.key} className={styles.step}>
            <span className={styles.stepLabel}>
              {tr(`insights.mkt.funnel.step.${step.key}`)}
              <small>
                {step.ofPrevious === null
                  ? tr("insights.mkt.funnel.entry")
                  : tr("insights.mkt.funnel.fromPrevious", { pct: percentOf(step.ofPrevious, 1), drop: integer(Math.max(0, step.dropOff ?? 0)) })}
              </small>
            </span>
            <span className={styles.stepBar}>
              <i style={{ width: step.ofEntry === null ? "0%" : `${Math.max(1, step.ofEntry).toFixed(1)}%` }} />
            </span>
            <span className={styles.stepValue}>
              <b>{integer(step.value)}</b>
              <small>{step.ofEntry === null ? "—" : percentOf(step.ofEntry, step.key === "sessions" ? 0 : 1)}</small>
            </span>
          </div>
        ))}
      </div>
      <p className={styles.summary}>
        {tr("insights.mkt.funnel.cvr")} <b>{cvr === null ? "—" : percentOf(cvr, 2)}</b>
        {cvr !== null && cvrBefore !== null ? (
          <span className={t.muted}>
            {" "}
            ({cvr - cvrBefore >= 0 ? "+" : "−"}
            {decimal(Math.abs(cvr - cvrBefore), 2)} {tr("insights.mkt.funnel.pts")} {tr("insights.kit.vs", { label: compareLabel })})
          </span>
        ) : null}
        {before && before.sessions > 0 ? (
          <span className={t.muted}> · {tr("insights.mkt.funnel.sessionsBefore", { n: integer(before.sessions) })}</span>
        ) : null}
      </p>
      <p className={styles.note}>{tr("insights.mkt.funnel.note")}</p>
    </section>
  );
}

/**
 * Checkout: the stages Shopify Analytics measures, per device, and the ones it
 * does not. Contact, address, shipping and payment steps are not in any
 * ShopifyQL dataset; they need the web pixel, so they are listed as such.
 */
function CheckoutCard({ data, filter }: { data: WebsitePerformanceData; filter: Filter }) {
  const tr = useT();
  const { integer, percentOf } = useFormat();
  const byDevice = foldTraffic(
    data.traffic.filter((r) => (!filter.group || r.group === filter.group) && (!filter.landingType || r.landingType === filter.landingType)),
    "device"
  ) as Map<string, FunnelCounts>;
  const rows = [...byDevice].sort((a, b) => b[1].sessions - a[1].sessions);
  return (
    <section className={styles.card}>
      <h2 className={styles.title}>
        {tr("insights.mkt.checkout.title")}
        <InfoTip text={tr("insights.mkt.checkout.tip")} />
      </h2>
      <div className={t.wrap}>
        <table className={t.table}>
          <thead>
            <tr>
              <th scope="col">{tr("insights.mkt.funnel.device")}</th>
              <th scope="col" className={t.n}>{tr("insights.mkt.checkout.carts")}</th>
              <th scope="col" className={t.n}>{tr("insights.mkt.checkout.reached")}</th>
              <th scope="col" className={t.n}>{tr("insights.mkt.checkout.completed")}</th>
              <th scope="col" className={t.n}>{tr("insights.mkt.checkout.completion")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([device, c]) => (
              <tr key={device}>
                <th scope="row">{tr(`insights.mkt.device.${device}`)}</th>
                <td className={t.n}>{integer(c.cartSessions)}</td>
                <td className={t.n}>{integer(c.checkoutSessions)}</td>
                <td className={t.n}>{integer(c.convertedSessions)}</td>
                <td className={t.n}>{c.checkoutSessions > 0 ? percentOf((c.convertedSessions / c.checkoutSessions) * 100, 1) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className={styles.unavailable}>
        {["contact", "address", "shipping", "payment", "methods", "failures", "express"].map((k) => (
          <li key={k}>
            <span>{tr(`insights.mkt.checkout.missing.${k}`)}</span>
            <small>{tr("insights.mkt.state.not_tracked")}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface SliceRow extends FunnelCounts {
  key: string;
  share: number | null;
  cartRate: number | null;
  checkoutRate: number | null;
  conversionRate: number | null;
  checkoutCompletion: number | null;
  previousRate: number | null;
  flag: boolean;
}

/**
 * Sessions and rates per value of one field, under the other filters. With
 * `flagGaps`, a slice converting under half of the best slice is flagged — only
 * when both have enough sessions to say so.
 */
function SliceTable({
  rows,
  field,
  filter,
  label,
  flagGaps = false,
  previous = null,
  compareLabel,
}: {
  rows: TrafficRow[];
  field: "device" | "group" | "landingType";
  filter: Filter;
  label: (key: string) => string;
  flagGaps?: boolean;
  previous?: TrafficRow[] | null;
  compareLabel?: string;
}) {
  const tr = useT();
  const { integer, percentOf, decimal } = useFormat();
  const filtered = rows.filter((r) => (!filter.device || r.device === filter.device) && (!filter.group || r.group === filter.group) && (!filter.landingType || r.landingType === filter.landingType));
  const before = previous
    ? (foldTraffic(
        previous.filter((r) => (!filter.device || r.device === filter.device) && (!filter.group || r.group === filter.group) && (!filter.landingType || r.landingType === filter.landingType)),
        field
      ) as Map<string, FunnelCounts>)
    : null;
  const folded = [...(foldTraffic(filtered, field) as Map<string, FunnelCounts>)];
  const total = folded.reduce((s, [, c]) => s + c.sessions, 0);
  const reliable = folded.filter(([, c]) => c.sessions >= MIN_COMPARE_SESSIONS).map(([, c]) => (c.sessions > 0 ? c.convertedSessions / c.sessions : 0));
  const best = reliable.length >= 2 ? Math.max(...reliable) : null;
  const data: SliceRow[] = folded.map(([key, c]) => {
    const r = rates(c) as Omit<SliceRow, keyof FunnelCounts | "key" | "share" | "previousRate" | "flag">;
    const b = before?.get(key);
    return {
      key,
      ...c,
      ...r,
      share: total > 0 ? (c.sessions / total) * 100 : null,
      previousRate: b && b.sessions > 0 ? (b.convertedSessions / b.sessions) * 100 : null,
      flag: flagGaps && best !== null && c.sessions >= MIN_COMPARE_SESSIONS && c.convertedSessions / c.sessions < best * 0.5,
    };
  });
  const dash = <span className={t.muted}>—</span>;
  const pct = (v: number | null, d = 1) => (v === null ? dash : percentOf(v, d));
  const col = (id: string, sort: (r: SliceRow) => number | null, render: (r: SliceRow) => ReactNode): Column<SliceRow> => ({
    id,
    label: tr(`insights.mkt.slice.${id}`),
    tip: tr(`insights.mkt.slice.tip.${id}`),
    numeric: true,
    sort,
    render,
  });
  const columns: Column<SliceRow>[] = [
    {
      id: "key",
      label: tr(`insights.mkt.slice.key.${field}`),
      sort: (r) => label(r.key),
      render: (r) => (
        <>
          {label(r.key)}
          {r.flag ? <span className={styles.flag}>{tr("insights.mkt.slice.gap")}</span> : null}
          {r.sessions < MIN_COMPARE_SESSIONS ? <span className={t.sub}>{tr("insights.mkt.slice.lowSample")}</span> : null}
        </>
      ),
    },
    col("sessions", (r) => r.sessions, (r) => integer(r.sessions)),
    col("share", (r) => r.share, (r) => pct(r.share, 0)),
    col("cart", (r) => r.cartRate, (r) => pct(r.cartRate)),
    col("checkout", (r) => r.checkoutRate, (r) => pct(r.checkoutRate)),
    col("completion", (r) => r.checkoutCompletion, (r) => pct(r.checkoutCompletion)),
    col("cvr", (r) => r.conversionRate, (r) => pct(r.conversionRate, 2)),
    ...(previous
      ? [
          col("cvrChange", (r) => (r.conversionRate !== null && r.previousRate !== null ? r.conversionRate - r.previousRate : null), (r) =>
            r.conversionRate !== null && r.previousRate !== null ? (
              <span title={compareLabel}>
                {r.conversionRate - r.previousRate >= 0 ? "+" : "−"}
                {decimal(Math.abs(r.conversionRate - r.previousRate), 2)} {tr("insights.mkt.funnel.pts")}
              </span>
            ) : (
              dash
            )
          ),
        ]
      : []),
  ];
  return <DataTable rows={data} columns={columns} rowKey={(r) => r.key} initialSort={{ id: "sessions", desc: true }} />;
}

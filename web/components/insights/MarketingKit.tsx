"use client";

import { Fragment, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { useT } from "@/lib/i18n/client";
import t from "./tables.module.css";
import styles from "./MarketingKit.module.css";

/**
 * Pieces the Marketing & funnel tabs share: a tooltip that explains a metric
 * (definition, source, limits), and a table that sorts, searches and expands.
 */

/** A small « i » that shows its text on hover and on keyboard focus. */
export function InfoTip({ text, label }: { text: string; label?: string }) {
  return (
    <span className={styles.tip} tabIndex={0} role="note" aria-label={label ? `${label}: ${text}` : text} data-tip={text}>
      i
    </span>
  );
}

export interface Column<R> {
  id: string;
  label: string;
  /** The metric's definition, shown as an InfoTip in the header. */
  tip?: string;
  numeric?: boolean;
  /** What the column sorts by; null sorts last whichever the direction. */
  sort?: (row: R) => number | string | null;
  render: (row: R) => ReactNode;
}

/**
 * A sortable table. `search` filters on the text it returns for a row;
 * `expand` renders a detail row under a clicked row. Nothing is fetched:
 * the server already sent the rows.
 */
export function DataTable<R>({
  rows,
  columns,
  rowKey,
  initialSort,
  search,
  searchPlaceholder,
  expand,
  limit,
  caption,
  empty,
}: {
  rows: R[];
  columns: Column<R>[];
  rowKey: (row: R) => string;
  initialSort?: { id: string; desc: boolean };
  search?: (row: R) => string;
  searchPlaceholder?: string;
  expand?: (row: R) => ReactNode;
  /** Rows shown before « Show all ». */
  limit?: number;
  caption?: string;
  empty?: ReactNode;
}) {
  const tr = useT();
  const [sort, setSort] = useState(initialSort ?? null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);

  const shown = useMemo(() => {
    const q = fold(query.trim());
    let out = q && search ? rows.filter((r) => fold(search(r)).includes(q)) : rows;
    const col = sort ? columns.find((c) => c.id === sort.id) : undefined;
    if (col?.sort) {
      const key = col.sort;
      out = [...out].sort((a, b) => {
        const x = key(a);
        const y = key(b);
        if (x === null && y === null) return 0;
        if (x === null) return 1;
        if (y === null) return -1;
        const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
        return sort!.desc ? -cmp : cmp;
      });
    }
    return out;
  }, [rows, columns, sort, query, search]);

  const visible = limit && !all ? shown.slice(0, limit) : shown;

  return (
    <>
      {search ? (
        <input
          className={styles.search}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={searchPlaceholder ?? tr("insights.mkt.table.search")}
          aria-label={searchPlaceholder ?? tr("insights.mkt.table.search")}
        />
      ) : null}
      <div className={`${t.wrap} ${styles.scroll}`}>
        <table className={t.table}>
          {caption ? <caption className={t.srOnly}>{caption}</caption> : null}
          <thead>
            <tr>
              {expand ? <th scope="col" className={styles.expandCol}><span className={t.srOnly}>{tr("insights.mkt.table.details")}</span></th> : null}
              {columns.map((c) => {
                const active = sort?.id === c.id;
                return (
                  <th
                    key={c.id}
                    scope="col"
                    className={c.numeric ? t.n : undefined}
                    aria-sort={active ? (sort!.desc ? "descending" : "ascending") : undefined}
                  >
                    {c.sort ? (
                      <button
                        type="button"
                        className={styles.sortButton}
                        onClick={() => setSort(active ? { id: c.id, desc: !sort!.desc } : { id: c.id, desc: Boolean(c.numeric) })}
                      >
                        {c.label}
                        <span aria-hidden="true" className={styles.sortMark}>{active ? (sort!.desc ? "↓" : "↑") : "↕"}</span>
                      </button>
                    ) : (
                      c.label
                    )}
                    {c.tip ? <InfoTip text={c.tip} label={c.label} /> : null}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={columns.length + (expand ? 1 : 0)} className={t.muted}>
                  {empty ?? tr("insights.mkt.table.empty")}
                </td>
              </tr>
            ) : (
              visible.map((row) => {
                const key = rowKey(row);
                const isOpen = open === key;
                return (
                  <Fragment key={key}>
                    <tr className={isOpen ? styles.openRow : undefined}>
                      {expand ? (
                        <td className={styles.expandCol}>
                          <button
                            type="button"
                            className={styles.expandButton}
                            aria-expanded={isOpen}
                            aria-label={tr(isOpen ? "insights.mkt.table.collapse" : "insights.mkt.table.expand")}
                            onClick={() => setOpen(isOpen ? null : key)}
                          >
                            {isOpen ? "−" : "+"}
                          </button>
                        </td>
                      ) : null}
                      {columns.map((c, i) =>
                        i === 0 ? (
                          <th key={c.id} scope="row" className={c.numeric ? t.n : undefined}>
                            {c.render(row)}
                          </th>
                        ) : (
                          <td key={c.id} className={c.numeric ? t.n : undefined}>
                            {c.render(row)}
                          </td>
                        )
                      )}
                    </tr>
                    {isOpen && expand ? (
                      <tr className={styles.detailRow}>
                        <td colSpan={columns.length + 1}>{expand(row)}</td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {limit && shown.length > limit ? (
        <button type="button" className={styles.more} onClick={() => setAll(!all)}>
          {all ? tr("insights.mkt.table.showFewer") : tr("insights.mkt.table.showAll", { n: shown.length })}
        </button>
      ) : null}
    </>
  );
}

/** Accent- and case-insensitive search text. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/** A dash that says why, for a figure that has no value. */
export function Dash({ reason }: { reason?: string | null }) {
  const tr = useT();
  return (
    <span className={t.muted} title={reason ? tr(reason) : undefined}>
      —
    </span>
  );
}

/** A link to another Insights panel, keeping the shop and the period. */
export function usePanelHref() {
  const params = useSearchParams();
  return (panel: string, extra: Record<string, string> = {}) => {
    const keep = new URLSearchParams();
    for (const key of ["shop", "range", "from", "to", "month", "platform"]) {
      const v = params?.get(key);
      if (v) keep.set(key, v);
    }
    for (const [k, v] of Object.entries(extra)) keep.set(k, v);
    return `/insights/${panel}?${keep.toString()}`;
  };
}

/** Horizontal bars for a few values on one scale (spend against two revenues). */
export function CompareBars({ bars }: { bars: { label: string; value: number | null; display: string; tone: "spend" | "provider" | "shopify" }[] }) {
  const max = Math.max(0, ...bars.map((b) => b.value ?? 0));
  return (
    <div className={styles.bars}>
      {bars.map((b) => (
        <div key={b.label} className={styles.barRow}>
          <span className={styles.barLabel}>{b.label}</span>
          <span className={styles.barTrack}>
            <i className={styles[`bar_${b.tone}`]} style={{ width: b.value === null || max === 0 ? "0%" : `${Math.max(1, (b.value / max) * 100).toFixed(1)}%` }} />
          </span>
          <span className={styles.barValue}>{b.display}</span>
        </div>
      ))}
    </div>
  );
}

/** Shopify's landing page type in the reader's language (« Blog Article » -> its key), or as Shopify wrote it. */
export function typeName(type: string, tr: (k: string) => string): string {
  const key = `insights.mkt.pageType.${type.replaceAll(" ", "")}`;
  const label = tr(key);
  return label === key ? type : label;
}

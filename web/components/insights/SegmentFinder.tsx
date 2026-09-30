"use client";

import { useMemo, useRef, useState } from "react";
import type { SegmentConnector, SegmentFinderResult, SegmentMetric, SegmentOperator } from "@/lib/types";
import {
  MAX_SEGMENT_CONDITIONS,
  SEGMENT_METRICS,
  SEGMENT_OPERATORS,
  SEGMENT_WINDOW_MONTHS,
  validateSegment,
} from "../../../scripts/lib/segment-finder.mjs";
import { useFormat, useLocale, useT } from "@/lib/i18n/client";
import { intlTag } from "@/lib/i18n/locales";
import { describeSegmentL, segmentError } from "@/lib/segment-messages";
import t from "./tables.module.css";
import styles from "./SegmentFinder.module.css";

interface Row {
  key: number;
  metric: SegmentMetric;
  op: SegmentOperator;
  value: string;
}

const INITIAL_ROWS: Row[] = [
  { key: 1, metric: "orders", op: "gt", value: "1" },
  { key: 2, metric: "spend", op: "gt", value: "100" },
];

/**
 * Build a group of customers from conditions and see who is in it.
 *
 * Each condition compares orders, spend (both over the last N months) or
 * lifetime spend with more than / less than a number; AND or OR sits in each
 * gap, AND binding tighter, and the sentence under the form prints the brackets
 * so what is read is what runs. Nothing is fetched until "Find customers",
 * because the answer names people and every search is logged.
 */
export function SegmentFinder() {
  const tr = useT();
  const locale = useLocale();
  const [windowMonths, setWindowMonths] = useState(String(SEGMENT_WINDOW_MONTHS.default));
  const [rows, setRows] = useState<Row[]>(INITIAL_ROWS);
  const [connectors, setConnectors] = useState<SegmentConnector[]>(["and"]);
  const [result, setResult] = useState<SegmentFinderResult | null>(null);
  const [resultFor, setResultFor] = useState<string | null>(null);
  const [resultDescription, setResultDescription] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const nextKey = useRef(INITIAL_ROWS.length + 1);

  const input = {
    windowMonths,
    conditions: rows.map(({ metric, op, value }) => ({ metric, op, value })),
    connectors,
  };
  const checked = validateSegment(input);
  const description = checked.ok ? describeSegmentL(checked.segment, tr, locale) : null;
  const signature = JSON.stringify(input);
  const stale = result !== null && resultFor !== signature;

  const update = (key: number, patch: Partial<Row>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const addRow = () => {
    if (rows.length >= MAX_SEGMENT_CONDITIONS) return;
    setRows((current) => [...current, { key: nextKey.current++, metric: "lifetime_spend", op: "gt", value: "" }]);
    setConnectors((current) => [...current, "and"]);
  };

  const removeRow = (index: number) => {
    if (rows.length <= 1) return;
    setRows((current) => current.filter((_, i) => i !== index));
    // The gap before a removed condition goes with it (or the one after, for the first).
    setConnectors((current) => current.filter((_, i) => i !== Math.max(0, index - 1)));
  };

  const find = async () => {
    if (!checked.ok) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/insights/segment-finder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(checked.segment),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error ?? tr("insights.customers.finder.couldNot"));
        return;
      }
      setResult(payload as SegmentFinderResult);
      setResultFor(signature);
      setResultDescription(description);
    } catch {
      setError(tr("insights.customers.finder.couldNot"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className={styles.card} aria-labelledby="segment-finder-title">
      <header className={styles.head}>
        <h2 id="segment-finder-title" className={styles.title}>
          {tr("insights.customers.finder")}
        </h2>
        <span className={styles.state}>{tr("insights.customers.finder.scope")}</span>
      </header>

      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          find();
        }}
      >
        <div className={styles.window}>
          <span>{tr("insights.customers.finder.countOver")}</span>
          <label className={styles.field}>
            <span className={styles.srOnly}>{tr("insights.customers.finder.rangeMonths")}</span>
            <input
              type="number"
              inputMode="numeric"
              min={SEGMENT_WINDOW_MONTHS.min}
              max={SEGMENT_WINDOW_MONTHS.max}
              step={1}
              value={windowMonths}
              onChange={(e) => setWindowMonths(e.target.value)}
              className={`${styles.input} ${styles.narrow}`}
            />
          </label>
          <span>{tr("insights.customers.finder.months")}</span>
        </div>

        <ol className={styles.rules}>
          {rows.map((row, index) => {
            const metric = SEGMENT_METRICS.find((m) => m.id === row.metric)!;
            return (
              <li key={row.key} className={styles.ruleItem}>
                {index > 0 ? (
                  <div className={styles.connector} role="group" aria-label={tr("insights.customers.finder.between", { a: index, b: index + 1 })}>
                    {(["and", "or"] as const).map((option) => (
                      <button
                        key={option}
                        type="button"
                        className={`${styles.connectorBtn} ${connectors[index - 1] === option ? styles.connectorOn : ""}`}
                        aria-pressed={connectors[index - 1] === option}
                        onClick={() =>
                          setConnectors((current) => current.map((c, i) => (i === index - 1 ? option : c)))
                        }
                      >
                        {tr(`insights.customers.finder.${option}`)}
                      </button>
                    ))}
                  </div>
                ) : null}

                <div className={styles.rule}>
                  <label className={styles.metricField}>
                    <span className={styles.srOnly}>{tr("insights.customers.finder.conditionWhat", { n: index + 1 })}</span>
                    <select
                      className={styles.select}
                      value={row.metric}
                      onChange={(e) => update(row.key, { metric: e.target.value as SegmentMetric })}
                    >
                      {SEGMENT_METRICS.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.windowed ? tr("insights.customers.finder.metricWindow", { label: tr(`insights.customers.finder.metric.${m.id}`), months: windowMonths || "N" }) : tr(`insights.customers.finder.metric.${m.id}`)}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className={styles.operator} role="group" aria-label={tr("insights.customers.finder.conditionCompare", { n: index + 1 })}>
                    {SEGMENT_OPERATORS.map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        className={`${styles.operatorBtn} ${row.op === o.id ? styles.operatorOn : ""}`}
                        aria-pressed={row.op === o.id}
                        aria-label={tr(`insights.customers.finder.op.${o.id}`)}
                        title={tr(`insights.customers.finder.op.${o.id}`)}
                        onClick={() => update(row.key, { op: o.id as SegmentOperator })}
                      >
                        {o.symbol}
                      </button>
                    ))}
                  </div>

                  <label className={styles.field}>
                    <span className={styles.srOnly}>{tr("insights.customers.finder.conditionValue", { n: index + 1 })}</span>
                    {metric.unit === "euro" ? (
                      <span className={styles.prefix} aria-hidden="true">
                        €
                      </span>
                    ) : null}
                    <input
                      type="number"
                      inputMode={metric.unit === "euro" ? "decimal" : "numeric"}
                      min={0}
                      step={metric.unit === "euro" ? "any" : 1}
                      value={row.value}
                      placeholder={metric.unit === "euro" ? "100" : "1"}
                      onChange={(e) => update(row.key, { value: e.target.value })}
                      className={`${styles.input} ${metric.unit === "euro" ? "" : styles.narrow}`}
                    />
                  </label>

                  <button
                    type="button"
                    className={styles.remove}
                    onClick={() => removeRow(index)}
                    disabled={rows.length <= 1}
                    aria-label={tr("insights.customers.finder.remove", { n: index + 1 })}
                    title={tr("insights.customers.finder.removeTitle")}
                  >
                    ×
                  </button>
                </div>
              </li>
            );
          })}
        </ol>

        <div className={styles.actions}>
          <button type="button" className={styles.add} onClick={addRow} disabled={rows.length >= MAX_SEGMENT_CONDITIONS}>
            {tr("insights.customers.finder.add")}
          </button>
          <button type="submit" className={styles.find} disabled={!checked.ok || loading}>
            {loading ? tr("insights.customers.finder.finding") : tr("insights.customers.finder.find")}
          </button>
        </div>

        <p className={styles.preview} role="status">
          {checked.ok ? (
            <>
              <span className={styles.previewLabel}>{tr("insights.customers.finder.where")}</span> {description}
            </>
          ) : (
            <span className={styles.error}>{segmentError(checked.error, tr)}</span>
          )}
        </p>
      </form>

      {error ? <p className={styles.error}>{error}</p> : null}

      {result ? <SegmentResult result={result} stale={stale} description={resultDescription ?? result.description} /> : null}
    </section>
  );
}

function SegmentResult({ result, stale, description }: { result: SegmentFinderResult; stale: boolean; description: string }) {
  const tr = useT();
  const locale = useLocale();
  const { euros, integer, percent } = useFormat();
  const lastOrder = useMemo(
    () => (iso: string | null) =>
      iso ? new Date(iso).toLocaleDateString(intlTag(locale), { day: "numeric", month: "short", year: "numeric" }) : tr("insights.customers.finder.never"),
    [locale, tr]
  );
  const window = tr("insights.customers.finder.lastMonths", { count: result.windowMonths, n: result.windowMonths });

  return (
    <div className={`${styles.result} ${stale ? styles.stale : ""}`}>
      {stale ? <p className={styles.staleNote}>{tr("insights.customers.finder.stale")}</p> : null}
      <p className={styles.resultFor}>{description}</p>

      <dl className={styles.stats}>
        <div>
          <dt>{tr("insights.sales.customers")}</dt>
          <dd>{integer(result.matched)}</dd>
          <span>
            {tr("insights.customers.finder.ofOnFile", { pct: percent(result.matched, result.baseCustomers), n: integer(result.baseCustomers) })} ·{" "}
            {tr("insights.customers.finder.ofBuyers", { pct: percent(Math.min(result.matched, result.baseBuyers), result.baseBuyers) })}
          </span>
        </div>
        <div>
          <dt>{tr("insights.customers.finder.onNewsletter")}</dt>
          <dd>{integer(result.matchedOnMarketingList)}</dd>
          <span>{tr("insights.customers.finder.ofSegment", { pct: percent(result.matchedOnMarketingList, result.matched) })}</span>
        </div>
        <div>
          <dt>{tr("insights.customers.finder.spentLast", { window })}</dt>
          <dd>{euros(result.matchedSpend)}</dd>
          <span>{tr("insights.customers.finder.netRefunds")}</span>
        </div>
        <div>
          <dt>{tr("insights.customers.sort.spend")}</dt>
          <dd>{euros(result.matchedLifetimeSpend)}</dd>
          <span>
            {result.matched > 0 ? tr("insights.customers.finder.perCustomer", { amount: euros(result.matchedLifetimeSpend / result.matched) }) : "—"}
          </span>
        </div>
      </dl>

      {result.members.length === 0 ? (
        <p className={styles.empty}>{tr("insights.customers.finder.noMatch")}</p>
      ) : (
        <>
          <div className={t.wrap}>
            <table className={t.table}>
              <thead>
                <tr>
                  <th scope="col">{tr("insights.fulfilment.open.customer")}</th>
                  <th scope="col" className={t.n}>
                    {tr("insights.overview.orders")}
                  </th>
                  <th scope="col" className={t.n}>
                    {tr("insights.customers.finder.metric.spend")}
                  </th>
                  <th scope="col" className={t.n}>
                    {tr("insights.customers.sort.spend")}
                  </th>
                  <th scope="col">{tr("insights.customers.finder.lastOrder")}</th>
                  <th scope="col">{tr("insights.customers.finder.newsletter")}</th>
                </tr>
              </thead>
              <tbody>
                {result.members.map((m) => (
                  <tr key={m.customerId}>
                    <th scope="row">{m.name ?? <span className={t.muted}>{tr("insights.fulfilment.open.noName")}</span>}</th>
                    <td className={t.n}>{integer(m.orders)}</td>
                    <td className={t.n}>{euros(m.spend, { cents: true })}</td>
                    <td className={t.n}>{euros(m.lifetimeSpend, { cents: true })}</td>
                    <td>{lastOrder(m.lastOrderAt)}</td>
                    <td>{m.onMarketingList ? tr("insights.customers.finder.subscribed") : <span className={t.muted}>—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.caption}>
            {result.matched > result.memberLimit
              ? tr("insights.customers.finder.topOf", { limit: result.memberLimit, n: integer(result.matched) })
              : tr("insights.customers.finder.allOf", { n: integer(result.matched) })}{" "}
            {tr("insights.customers.finder.cover", { window })}
          </p>
        </>
      )}
    </div>
  );
}

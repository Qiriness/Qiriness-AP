"use client";

import { useMemo, useRef, useState } from "react";
import type { SegmentConnector, SegmentFinderResult, SegmentMetric, SegmentOperator } from "@/lib/types";
import {
  MAX_SEGMENT_CONDITIONS,
  SEGMENT_METRICS,
  SEGMENT_OPERATORS,
  SEGMENT_WINDOW_MONTHS,
  describeSegment,
  validateSegment,
} from "../../../scripts/lib/segment-finder.mjs";
import { euros, percent } from "./InsightsKit";
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
  const [windowMonths, setWindowMonths] = useState(String(SEGMENT_WINDOW_MONTHS.default));
  const [rows, setRows] = useState<Row[]>(INITIAL_ROWS);
  const [connectors, setConnectors] = useState<SegmentConnector[]>(["and"]);
  const [result, setResult] = useState<SegmentFinderResult | null>(null);
  const [resultFor, setResultFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const nextKey = useRef(INITIAL_ROWS.length + 1);

  const input = {
    windowMonths,
    conditions: rows.map(({ metric, op, value }) => ({ metric, op, value })),
    connectors,
  };
  const checked = validateSegment(input);
  const description = checked.ok ? describeSegment(checked.segment) : null;
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
        setError(payload.error ?? "Could not find this segment.");
        return;
      }
      setResult(payload as SegmentFinderResult);
      setResultFor(signature);
    } catch {
      setError("Could not find this segment.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className={styles.card} aria-labelledby="segment-finder-title">
      <header className={styles.head}>
        <h2 id="segment-finder-title" className={styles.title}>
          Segment finder
        </h2>
        <span className={styles.state}>Shopify customers; Amazon and Yves Rocher cannot be tied to a person</span>
      </header>

      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          find();
        }}
      >
        <div className={styles.window}>
          <span>Count orders and spend over the last</span>
          <label className={styles.field}>
            <span className={styles.srOnly}>Time range in months</span>
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
          <span>months.</span>
        </div>

        <ol className={styles.rules}>
          {rows.map((row, index) => {
            const metric = SEGMENT_METRICS.find((m) => m.id === row.metric)!;
            return (
              <li key={row.key} className={styles.ruleItem}>
                {index > 0 ? (
                  <div className={styles.connector} role="group" aria-label={`Between conditions ${index} and ${index + 1}`}>
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
                        {option.toUpperCase()}
                      </button>
                    ))}
                  </div>
                ) : null}

                <div className={styles.rule}>
                  <label className={styles.metricField}>
                    <span className={styles.srOnly}>Condition {index + 1}: what to compare</span>
                    <select
                      className={styles.select}
                      value={row.metric}
                      onChange={(e) => update(row.key, { metric: e.target.value as SegmentMetric })}
                    >
                      {SEGMENT_METRICS.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.windowed ? `${m.label} (last ${windowMonths || "N"} months)` : m.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className={styles.operator} role="group" aria-label={`Condition ${index + 1}: comparison`}>
                    {SEGMENT_OPERATORS.map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        className={`${styles.operatorBtn} ${row.op === o.id ? styles.operatorOn : ""}`}
                        aria-pressed={row.op === o.id}
                        aria-label={o.label}
                        title={o.label}
                        onClick={() => update(row.key, { op: o.id as SegmentOperator })}
                      >
                        {o.symbol}
                      </button>
                    ))}
                  </div>

                  <label className={styles.field}>
                    <span className={styles.srOnly}>Condition {index + 1}: value</span>
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
                    aria-label={`Remove condition ${index + 1}`}
                    title="Remove this condition"
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
            + Add condition
          </button>
          <button type="submit" className={styles.find} disabled={!checked.ok || loading}>
            {loading ? "Finding…" : "Find customers"}
          </button>
        </div>

        <p className={styles.preview} role="status">
          {checked.ok ? (
            <>
              <span className={styles.previewLabel}>Customers where</span> {description}
            </>
          ) : (
            <span className={styles.error}>{checked.error}</span>
          )}
        </p>
      </form>

      {error ? <p className={styles.error}>{error}</p> : null}

      {result ? <SegmentResult result={result} stale={stale} /> : null}
    </section>
  );
}

function SegmentResult({ result, stale }: { result: SegmentFinderResult; stale: boolean }) {
  const lastOrder = useMemo(
    () => (iso: string | null) =>
      iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "Never",
    []
  );

  return (
    <div className={`${styles.result} ${stale ? styles.stale : ""}`}>
      {stale ? <p className={styles.staleNote}>The conditions changed since this search — find again to update.</p> : null}
      <p className={styles.resultFor}>{result.description}</p>

      <dl className={styles.stats}>
        <div>
          <dt>Customers</dt>
          <dd>{result.matched.toLocaleString("en-GB")}</dd>
          <span>
            {percent(result.matched, result.baseCustomers)} of {result.baseCustomers.toLocaleString("en-GB")} on file ·{" "}
            {percent(Math.min(result.matched, result.baseBuyers), result.baseBuyers)} of buyers
          </span>
        </div>
        <div>
          <dt>On the newsletter</dt>
          <dd>{result.matchedOnMarketingList.toLocaleString("en-GB")}</dd>
          <span>{percent(result.matchedOnMarketingList, result.matched)} of this segment</span>
        </div>
        <div>
          <dt>Spent, last {result.windowMonths === 1 ? "month" : `${result.windowMonths} months`}</dt>
          <dd>{euros(result.matchedSpend)}</dd>
          <span>Net of refunds</span>
        </div>
        <div>
          <dt>Lifetime spend</dt>
          <dd>{euros(result.matchedLifetimeSpend)}</dd>
          <span>
            {result.matched > 0 ? `${euros(result.matchedLifetimeSpend / result.matched)} per customer` : "—"}
          </span>
        </div>
      </dl>

      {result.members.length === 0 ? (
        <p className={styles.empty}>No customer matches these conditions.</p>
      ) : (
        <>
          <div className={t.wrap}>
            <table className={t.table}>
              <thead>
                <tr>
                  <th scope="col">Customer</th>
                  <th scope="col" className={t.n}>
                    Orders
                  </th>
                  <th scope="col" className={t.n}>
                    Spent
                  </th>
                  <th scope="col" className={t.n}>
                    Lifetime spend
                  </th>
                  <th scope="col">Last order</th>
                  <th scope="col">Newsletter</th>
                </tr>
              </thead>
              <tbody>
                {result.members.map((m) => (
                  <tr key={m.customerId}>
                    <th scope="row">{m.name ?? <span className={t.muted}>No name on file</span>}</th>
                    <td className={t.n}>{m.orders.toLocaleString("en-GB")}</td>
                    <td className={t.n}>{euros(m.spend, { cents: true })}</td>
                    <td className={t.n}>{euros(m.lifetimeSpend, { cents: true })}</td>
                    <td>{lastOrder(m.lastOrderAt)}</td>
                    <td>{m.onMarketingList ? "Subscribed" : <span className={t.muted}>—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.caption}>
            {result.matched > result.memberLimit
              ? `The ${result.memberLimit} with the highest lifetime spend, of ${result.matched.toLocaleString("en-GB")}.`
              : `All ${result.matched.toLocaleString("en-GB")}, highest lifetime spend first.`}{" "}
            Orders and Spent cover the last {result.windowMonths === 1 ? "month" : `${result.windowMonths} months`}.
          </p>
        </>
      )}
    </div>
  );
}

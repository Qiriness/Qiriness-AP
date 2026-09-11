"use client";

import { useEffect, useRef, useState } from "react";
import type { VipRule } from "@/lib/types";
import { useInsightsFrame } from "./InsightsFrame";
import styles from "./VipRuleCard.module.css";

interface Summary {
  vipCustomers: number;
  buyersInWindow: number;
}

/**
 * Where the shop decides who is a VIP.
 *
 * THREE NUMBERS, BOTH CONDITIONS. The sentence the form reads as is the rule:
 * more than €X spent AND more than N orders, in the last M months. The live
 * count underneath answers "how many would that be" before anything is saved,
 * so the numbers are chosen against the store's real customers rather than
 * guessed. Saving re-renders the page, and the queue picks the rule up on its
 * next read — nothing is cached anywhere.
 */
export function VipRuleCard({
  rule,
  current,
}: {
  rule: (VipRule & { description: string }) | null;
  /** What the SAVED rule admits today, so the card has a figure before anything is typed. */
  current: Summary | null;
}) {
  const { refresh } = useInsightsFrame();
  const [minSpend, setMinSpend] = useState(rule ? String(rule.minSpend) : "");
  const [minOrders, setMinOrders] = useState(rule ? String(rule.minOrders) : "");
  const [windowMonths, setWindowMonths] = useState(rule ? String(rule.windowMonths) : "12");
  const [preview, setPreview] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const request = useRef(0);

  const dirty =
    !rule ||
    Number(minSpend) !== rule.minSpend ||
    Number(minOrders) !== rule.minOrders ||
    Number(windowMonths) !== rule.windowMonths;
  const complete = minSpend !== "" && minOrders !== "" && windowMonths !== "";

  // A debounced count for whatever is typed, so the threshold is picked against
  // real numbers. Only the latest request may write the result.
  useEffect(() => {
    if (!complete) {
      setPreview(null);
      return;
    }
    const id = ++request.current;
    const timer = window.setTimeout(async () => {
      const params = new URLSearchParams({ minSpend, minOrders, windowMonths });
      try {
        const response = await fetch(`/api/insights/vip-rule?${params.toString()}`);
        const payload = await response.json();
        if (id !== request.current) return;
        if (!response.ok) {
          setError(payload.error ?? "Could not check this rule.");
          setPreview(null);
        } else {
          setError(null);
          setPreview(payload.summary);
        }
      } catch {
        if (id === request.current) setError("Could not check this rule.");
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [minSpend, minOrders, windowMonths, complete]);

  const save = async (clear = false) => {
    setSaving(true);
    setSaved(false);
    try {
      const response = await fetch("/api/insights/vip-rule", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(clear ? { clear: true } : { minSpend, minOrders, windowMonths }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error ?? "Could not save the rule.");
      } else {
        setError(null);
        setSaved(true);
        if (clear) {
          setMinSpend("");
          setMinOrders("");
        }
        refresh();
      }
    } catch {
      setError("Could not save the rule.");
    } finally {
      setSaving(false);
    }
  };

  const shown = preview ?? (rule && !dirty ? current : null);

  return (
    <section className={styles.card} aria-labelledby="vip-rule-title">
      <header className={styles.head}>
        <h2 id="vip-rule-title" className={styles.title}>
          VIP rule
        </h2>
        <span className={styles.state}>
          {rule ? (dirty ? "Unsaved changes" : "Active on the ticket queue, this panel and the agent") : "Not set — nobody is a VIP"}
        </span>
      </header>

      <form
        className={styles.sentence}
        onSubmit={(event) => {
          event.preventDefault();
          if (complete && dirty) save();
        }}
      >
        <span>A customer is a VIP when they have spent more than</span>
        <label className={styles.field}>
          <span className={styles.srOnly}>Minimum spend in euros</span>
          <span className={styles.prefix} aria-hidden="true">
            €
          </span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            value={minSpend}
            onChange={(e) => setMinSpend(e.target.value)}
            className={styles.input}
            placeholder="300"
          />
        </label>
        <strong className={styles.and}>and</strong>
        <span>placed more than</span>
        <label className={styles.field}>
          <span className={styles.srOnly}>Minimum number of orders</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={minOrders}
            onChange={(e) => setMinOrders(e.target.value)}
            className={`${styles.input} ${styles.narrow}`}
            placeholder="2"
          />
        </label>
        <span>orders, both in the last</span>
        <label className={styles.field}>
          <span className={styles.srOnly}>Window in months</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={120}
            step={1}
            value={windowMonths}
            onChange={(e) => setWindowMonths(e.target.value)}
            className={`${styles.input} ${styles.narrow}`}
          />
        </label>
        <span>months.</span>

        <div className={styles.actions}>
          <button type="submit" className={styles.save} disabled={!complete || !dirty || saving || Boolean(error)}>
            {saving ? "Saving…" : "Save rule"}
          </button>
          {rule ? (
            <button type="button" className={styles.clear} onClick={() => save(true)} disabled={saving}>
              Remove rule
            </button>
          ) : null}
        </div>
      </form>

      <p className={styles.result} role="status">
        {error ? (
          <span className={styles.error}>{error}</span>
        ) : shown ? (
          <>
            <strong>{shown.vipCustomers.toLocaleString("en-GB")}</strong>{" "}
            {shown.vipCustomers === 1 ? "customer qualifies" : "customers qualify"}
            {shown.buyersInWindow > 0 ? (
              <> of {shown.buyersInWindow.toLocaleString("en-GB")} who ordered in that window</>
            ) : null}
            {dirty && rule ? " — not saved yet" : saved ? " — saved" : ""}
            <span className={styles.note}> Shopify orders only; Amazon and Yves Rocher cannot be tied to a person.</span>
          </>
        ) : (
          "Fill in all three to see how many customers qualify."
        )}
      </p>
    </section>
  );
}

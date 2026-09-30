"use client";

import { useEffect, useRef, useState } from "react";
import type { VipRule } from "@/lib/types";
import { useFormat, useT } from "@/lib/i18n/client";
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
  const t = useT();
  const { integer } = useFormat();
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
          setError(payload.error ?? t("insights.customers.vip.couldNotCheck"));
          setPreview(null);
        } else {
          setError(null);
          setPreview(payload.summary);
        }
      } catch {
        if (id === request.current) setError(t("insights.customers.vip.couldNotCheck"));
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [minSpend, minOrders, windowMonths, complete, t]);

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
        setError(payload.error ?? t("insights.customers.vip.couldNotSave"));
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
      setError(t("insights.customers.vip.couldNotSave"));
    } finally {
      setSaving(false);
    }
  };

  const shown = preview ?? (rule && !dirty ? current : null);

  return (
    <section className={styles.card} aria-labelledby="vip-rule-title">
      <header className={styles.head}>
        <h2 id="vip-rule-title" className={styles.title}>
          {t("insights.customers.vip.title")}
        </h2>
        <span className={styles.state}>
          {rule ? (dirty ? t("insights.customers.vip.unsaved") : t("insights.customers.vip.active")) : t("insights.customers.vip.notSet")}
        </span>
      </header>

      <form
        className={styles.sentence}
        onSubmit={(event) => {
          event.preventDefault();
          if (complete && dirty) save();
        }}
      >
        <span>{t("insights.customers.vip.sentence1")}</span>
        <label className={styles.field}>
          <span className={styles.srOnly}>{t("insights.customers.vip.minSpend")}</span>
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
        <strong className={styles.and}>{t("insights.customers.finder.and").toLowerCase()}</strong>
        <span>{t("insights.customers.vip.sentence2")}</span>
        <label className={styles.field}>
          <span className={styles.srOnly}>{t("insights.customers.vip.minOrders")}</span>
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
        <span>{t("insights.customers.vip.sentence3")}</span>
        <label className={styles.field}>
          <span className={styles.srOnly}>{t("insights.customers.vip.window")}</span>
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
        <span>{t("insights.customers.finder.months")}</span>

        <div className={styles.actions}>
          <button type="submit" className={styles.save} disabled={!complete || !dirty || saving || Boolean(error)}>
            {saving ? t("tickets.panels.saving") : t("insights.customers.vip.save")}
          </button>
          {rule ? (
            <button type="button" className={styles.clear} onClick={() => save(true)} disabled={saving}>
              {t("insights.customers.vip.remove")}
            </button>
          ) : null}
        </div>
      </form>

      <p className={styles.result} role="status">
        {error ? (
          <span className={styles.error}>{error}</span>
        ) : shown ? (
          <>
            <strong>{integer(shown.vipCustomers)}</strong>{" "}
            {t("insights.customers.vip.qualify", { count: shown.vipCustomers })}
            {shown.buyersInWindow > 0 ? (
              <> {t("insights.customers.vip.ofWindow", { n: integer(shown.buyersInWindow) })}</>
            ) : null}
            {dirty && rule ? ` — ${t("insights.customers.vip.notSaved")}` : saved ? ` — ${t("insights.customers.vip.saved")}` : ""}
            <span className={styles.note}> {t("insights.customers.vip.scope")}</span>
          </>
        ) : (
          t("insights.customers.vip.fill")
        )}
      </p>
    </section>
  );
}

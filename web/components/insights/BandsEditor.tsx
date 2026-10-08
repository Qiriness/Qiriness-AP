"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/client";
import type { BandMetric, BandMode, BandRule, OrganicKind } from "@/lib/social-types";
import styles from "./SocialView.module.css";

const METRICS: BandMetric[] = ["views", "reach", "engagementRate", "likes", "comments", "shares", "follows", "engagement"];
/** A rate is already a ratio, so « % of followers » is not offered for it (as social-bands.mjs `modesFor`). */
const modesFor = (metric: BandMetric): BandMode[] => (metric === "engagementRate" ? ["off", "absolute", "median"] : ["off", "absolute", "followers", "median"]);

type Draft = Record<BandMetric, { mode: BandMode; low: string; high: string }>;

const toDraft = (rules: Record<BandMetric, BandRule>): Draft =>
  Object.fromEntries(METRICS.map((m) => [m, { mode: rules[m].mode, low: rules[m].low === null ? "" : String(rules[m].low), high: rules[m].high === null ? "" : String(rules[m].high) }])) as Draft;

/**
 * Colour bands for one platform's post metrics: per metric, how a number is
 * measured (off, a fixed number, a % of followers, a % of the median post) and
 * the two limits. Below the low limit is low, the high limit and above is high.
 * Saved for the platform as a whole, so every post in the table is recoloured.
 */
export function BandsEditor({ kind, rules, custom }: { kind: OrganicKind; rules: Record<BandMetric, BandRule>; custom: boolean }) {
  const tr = useT();
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => toDraft(rules));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);

  const fingerprint = JSON.stringify(rules);
  useEffect(() => setDraft(toDraft(rules)), [fingerprint]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (metric: BandMetric, patch: Partial<Draft[BandMetric]>) => setDraft((d) => ({ ...d, [metric]: { ...d[metric], ...patch } }));

  async function send(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/insights/social/bands", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error((await response.json().catch(() => ({})))?.error ?? `HTTP ${response.status}`);
      setMessage({ error: false, text: done });
      router.refresh();
    } catch (e) {
      setMessage({ error: true, text: tr("insights.social.bands.failed", { reason: e instanceof Error ? e.message : String(e) }) });
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    send(
      { kind, rules: Object.fromEntries(METRICS.map((m) => [m, draft[m].mode === "off" ? { mode: "off" } : { mode: draft[m].mode, low: draft[m].low, high: draft[m].high }])) },
      tr("insights.social.bands.saved")
    );

  return (
    <details className={styles.bands}>
      <summary>
        {tr("insights.social.bands.title")}
        <span className={styles.bandLegend} aria-hidden="true">
          <i className={styles.bandLow}>{tr("insights.social.band.low")}</i>
          <i className={styles.bandMedium}>{tr("insights.social.band.medium")}</i>
          <i className={styles.bandHigh}>{tr("insights.social.band.high")}</i>
        </span>
      </summary>
      <p className={styles.basisHint}>{tr("insights.social.bands.help")}</p>
      <div className={styles.bandRows}>
        {METRICS.map((metric) => {
          const row = draft[metric];
          const unit = row.mode === "absolute" ? (metric === "engagementRate" ? "%" : "") : "%";
          return (
            <div key={metric} className={styles.bandRow}>
              <span className={styles.bandMetric}>{tr(`insights.social.posts.col.${metric}`)}</span>
              <select className={styles.select} value={row.mode} disabled={busy} aria-label={tr("insights.social.bands.mode")} onChange={(e) => set(metric, { mode: e.target.value as BandMode })}>
                {modesFor(metric).map((mode) => (
                  <option key={mode} value={mode}>
                    {tr(`insights.social.bands.mode.${mode}`)}
                  </option>
                ))}
              </select>
              {row.mode === "off" ? null : (
                <span className={styles.bandLimits}>
                  <label>
                    {tr("insights.social.bands.below")}
                    <input className={styles.bandInput} type="number" min={0} step="any" inputMode="decimal" value={row.low} disabled={busy} onChange={(e) => set(metric, { low: e.target.value })} />
                    {unit}
                  </label>
                  <label>
                    {tr("insights.social.bands.above")}
                    <input className={styles.bandInput} type="number" min={0} step="any" inputMode="decimal" value={row.high} disabled={busy} onChange={(e) => set(metric, { high: e.target.value })} />
                    {unit}
                  </label>
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className={styles.bandActions}>
        <button type="button" className={styles.bandButton} disabled={busy} onClick={save}>
          {tr("insights.social.bands.save")}
        </button>
        <button type="button" className={styles.bandButtonQuiet} disabled={busy || !custom} onClick={() => send({ kind, reset: true }, tr("insights.social.bands.resetDone"))}>
          {tr("insights.social.bands.reset")}
        </button>
        {message ? (
          <span role={message.error ? "alert" : "status"} className={message.error ? styles.tagError : styles.basisHint}>
            {message.text}
          </span>
        ) : null}
      </div>
    </details>
  );
}

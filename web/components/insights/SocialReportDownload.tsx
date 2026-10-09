"use client";
import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import type { OrganicKind } from "@/lib/social-types";
import { Card } from "./InsightsKit";
import styles from "./SocialReportDownload.module.css";

export interface SocialReportOptions {
  months: { id: string; label: string }[];
  initial: string;
  span: 1 | 6 | 12;
}
export function SocialReportDownload({ kinds, options }: { kinds: OrganicKind[]; options: SocialReportOptions }) {
  const t = useT();
  const [month, setMonth] = useState(options.months.some(m => m.id === options.initial) ? options.initial : options.months[0]?.id ?? "");
  const [span, setSpan] = useState(options.span);
  const [selected, setSelected] = useState<string[]>(kinds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const included = kinds.filter(kind => selected.includes(kind));
  async function download() {
    setBusy(true); setError(false);
    try {
      const query = new URLSearchParams({ month, months: String(span), platforms: included.join(",") });
      const response = await fetch("/api/insights/social/report?" + query);
      if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) throw new Error("Report unavailable");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url; link.download = "social-report-" + month + "-" + span + "m.html";
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch { setError(true); }
    finally { setBusy(false); }
  }
  return (
    <Card title={t("insights.social.report.title")}>
      <div className={styles.controls}>
        <label className={styles.label}><span>{t("insights.social.report.endMonth")}</span>
          <select className={styles.select} value={month} onChange={e => setMonth(e.target.value)}>
            {options.months.map(m => <option value={m.id} key={m.id}>{m.label}</option>)}
          </select>
        </label>
        <label className={styles.label}><span>{t("insights.social.report.period")}</span>
          <select className={styles.select} value={span} onChange={e => setSpan(Number(e.target.value) as 1 | 6 | 12)}>
            <option value={1}>{t("insights.social.report.mom")}</option>
            <option value={6}>{t("insights.social.report.six")}</option>
            <option value={12}>{t("insights.social.report.year")}</option>
          </select>
        </label>
        <fieldset className={styles.platforms}>
          <legend>{t("insights.social.report.platforms")}</legend>
          {kinds.map(kind => <label key={kind}>
            <input type="checkbox" checked={included.includes(kind)} onChange={e => setSelected(e.target.checked ? [...selected, kind] : selected.filter(k => k !== kind))} />
            {t(kind === "instagram" ? "insights.social.kind.instagram" : "insights.social.kind.facebook")}
          </label>)}
        </fieldset>
        <button className={styles.button} type="button" onClick={download} disabled={busy || !month || !included.length}>
          {t(busy ? "insights.social.report.building" : "insights.social.report.download")}
        </button>
      </div>
      <p className={styles.hint}>{t("insights.social.report.hint")}</p>
      {!included.length ? <p className={styles.hint}>{t("insights.social.report.choose")}</p> : null}
      {error ? <p role="alert" className={styles.error}>{t("insights.social.report.error")}</p> : null}
    </Card>
  );
}

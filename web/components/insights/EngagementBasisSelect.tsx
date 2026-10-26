"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/client";
import type { EngagementBasis, OrganicKind } from "@/lib/social-types";
import styles from "./SocialView.module.css";
import { useInsightsFrame } from "./InsightsFrame";

const BASES: EngagementBasis[] = ["reach", "followers", "views"];

/**
 * Which denominator a platform's engagement rate uses (82): interactions over
 * followers, over reach, or over views. One at a time, per platform; the choice
 * is saved at once and the page re-reads, so every rate on it follows.
 */
export function EngagementBasisSelect({ kind, basis }: { kind: OrganicKind; basis: EngagementBasis }) {
  const { api } = useInsightsFrame();
  const tr = useT();
  const router = useRouter();
  const [value, setValue] = useState(basis);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(next: EngagementBasis) {
    const before = value;
    setValue(next);
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(api("/api/insights/social/engagement-basis"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, basis: next }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({})))?.error ?? `HTTP ${response.status}`);
      router.refresh();
    } catch (e) {
      setValue(before);
      setError(tr("insights.social.rateBasis.failed", { reason: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.basisBar}>
      <label className={styles.basisLabel}>
        {tr("insights.social.rateBasis.label")}
        <select className={styles.select} value={value} disabled={saving} onChange={(e) => choose(e.target.value as EngagementBasis)}>
          {BASES.map((b) => (
            <option key={b} value={b}>
              {tr(`insights.social.rateBasis.${b}`)}
            </option>
          ))}
        </select>
      </label>
      <details className={styles.basisInfo} onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
        }
      }}>
        <summary aria-label={tr("insights.social.rateBasis.info")}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v6M12 7v1" />
          </svg>
        </summary>
        <p className={styles.basisHint}>{tr(`insights.social.rateBasis.${value}.hint`)}</p>
      </details>
      {error && <span role="alert">{error}</span>}
    </div>
  );
}

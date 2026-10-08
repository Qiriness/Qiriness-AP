"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/client";
import type { EngagementBasis, OrganicKind } from "@/lib/social-types";
import styles from "./SocialView.module.css";

const BASES: EngagementBasis[] = ["reach", "followers", "views"];

/**
 * Which denominator a platform's engagement rate uses (82): interactions over
 * followers, over reach, or over views. One at a time, per platform; the choice
 * is saved at once and the page re-reads, so every rate on it follows.
 */
export function EngagementBasisSelect({ kind, basis }: { kind: OrganicKind; basis: EngagementBasis }) {
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
      const response = await fetch("/api/insights/social/engagement-basis", {
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
      <span className={styles.basisHint}>{error ?? tr(`insights.social.rateBasis.${value}.hint`)}</span>
    </div>
  );
}

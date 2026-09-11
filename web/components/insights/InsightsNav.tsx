"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { InsightsPanel } from "@/lib/types";
import { INSIGHTS_PANELS } from "@/lib/types";
import styles from "./InsightsHeader.module.css";

/** The query keys a panel switch carries over, so the range survives a tab change. */
const KEPT = ["range", "from", "to", "platform"];

/**
 * The bar that switches panels. Real links, so each panel can be bookmarked and
 * opened in a background tab — and each link carries the current range and
 * platform, so "last 7 days" does not snap back to 30 on every tab.
 */
export function InsightsNav({ active }: { active: InsightsPanel }) {
  const params = useSearchParams();
  const kept = new URLSearchParams();
  for (const key of KEPT) {
    const value = params?.get(key);
    if (value) kept.set(key, value);
  }
  const suffix = kept.toString() ? `?${kept.toString()}` : "";

  return (
    <nav className={styles.nav} aria-label="Insights panels">
      <ul className={styles.tabs}>
        {INSIGHTS_PANELS.map((panel) => {
          const current = panel.id === active;
          return (
            <li key={panel.id}>
              <Link
                href={`${panel.href}${suffix}`}
                className={`${styles.tab} ${current ? styles.tabActive : ""}`}
                aria-current={current ? "page" : undefined}
              >
                {panel.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

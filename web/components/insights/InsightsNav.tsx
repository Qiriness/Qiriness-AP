"use client";

import { useEffect, useState, type MouseEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { InsightsPanel } from "@/lib/types";
import { INSIGHTS_PANELS } from "@/lib/types";
import { useInsightsFrame } from "./InsightsFrame";
import styles from "./InsightsHeader.module.css";

/** The query keys a panel switch carries over, so the range survives a tab change. */
const KEPT = ["range", "from", "to", "platform"];

/**
 * The bar that switches panels. Real links, so each panel can be bookmarked and
 * opened in a background tab — and each link carries the current range and
 * platform, so "last 7 days" does not snap back to 30 on every tab.
 *
 * THE TAB MOVES ON THE CLICK, not when the server answers. A panel render reads
 * the database, so the URL changes a second or two after the click; left alone,
 * the old tab stays underlined for that whole time and the click reads as
 * having missed. So a plain click is handled here: the clicked tab is drawn as
 * the current one straight away, the frame dims and spins, and the real
 * navigation catches up. Modified clicks (a new tab, a middle click) are left
 * to the browser, which is the point of keeping real links.
 */
export function InsightsNav({ active, panels }: { active: InsightsPanel; panels: InsightsPanel[] }) {
  const params = useSearchParams();
  const { go, pending } = useInsightsFrame();
  const [target, setTarget] = useState<InsightsPanel | null>(null);

  // Once the page it asked for has arrived, the guess stops being a guess.
  useEffect(() => setTarget(null), [active]);
  useEffect(() => {
    if (!pending) setTarget(null);
  }, [pending]);

  const kept = new URLSearchParams();
  for (const key of KEPT) {
    const value = params?.get(key);
    if (value) kept.set(key, value);
  }
  const suffix = kept.toString() ? `?${kept.toString()}` : "";
  const current = target ?? active;

  return (
    <nav className={styles.nav} aria-label="Insights panels">
      <ul className={styles.tabs}>
        {INSIGHTS_PANELS.filter((panel) => panels.includes(panel.id)).map((panel) => {
          const isCurrent = panel.id === current;
          const href = `${panel.href}${suffix}`;
          return (
            <li key={panel.id}>
              <Link
                href={href}
                className={`${styles.tab} ${isCurrent ? styles.tabActive : ""}`}
                aria-current={isCurrent ? "page" : undefined}
                onClick={(event: MouseEvent<HTMLAnchorElement>) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                  if (panel.id === active) return;
                  event.preventDefault();
                  setTarget(panel.id);
                  go(href, panel.label.toLowerCase());
                }}
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

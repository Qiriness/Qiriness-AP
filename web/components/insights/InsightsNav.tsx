"use client";

import Link from "next/link";
import type { InsightsPanel } from "@/lib/types";
import { INSIGHTS_PANELS } from "@/lib/types";
import styles from "./InsightsNav.module.css";

interface InsightsNavProps {
  active: InsightsPanel;
}

/**
 * The bar that switches panels.
 *
 * REAL LINKS, NOT CLIENT STATE. Each panel is its own route, so it can be
 * bookmarked, linked to in a message, and opened in a background tab — which is
 * how a dashboard actually gets used once more than one person reads it. Tab
 * state in React would have been less code and none of that.
 *
 * The sidebar keeps owning the app; this owns the panels inside Insights. Two
 * levels of navigation, each with one job.
 */
export function InsightsNav({ active }: InsightsNavProps) {
  return (
    <nav className={styles.nav} aria-label="Insights panels">
      <ul className={styles.list}>
        {INSIGHTS_PANELS.map((panel) => {
          const current = panel.id === active;
          return (
            <li key={panel.id}>
              <Link
                href={panel.href}
                className={`${styles.tab} ${current ? styles.active : ""}`}
                // The styling is a teal underline; on its own that is colour
                // carrying the whole message, which is exactly what a screen
                // reader and a monochrome display both miss.
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

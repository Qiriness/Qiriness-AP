"use client";

import { useEffect, useState, type MouseEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { InsightsPanel } from "@/lib/types";
import { INSIGHTS_PANELS } from "@/lib/types";
import { useT } from "@/lib/i18n/client";
import { useInsightsFrame } from "./InsightsFrame";
import styles from "./InsightsHeader.module.css";

/**
 * After a panel has settled, the other tabs are rendered in the background one
 * at a time: the first after SETTLE_MS, then one every STAGGER_MS.
 */
const SETTLE_MS = 3_000;
const STAGGER_MS = 2_000;

/** The query keys a panel switch carries over, so the range survives a tab change. */
const KEPT = ["range", "from", "to", "month", "platform"];

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
 *
 * THE OTHER TABS ARE PRE-LOADED, BUT AFTER THIS ONE, AND ONE AT A TIME. A click
 * then shows a page already rendered. They used to be prefetched all at once
 * the moment the bar appeared, which is on every range change too: measured
 * 2026-10-26, a switch to 1 year rendered all seven at once (Sales 9 s,
 * Marketing 10 s, Fulfilment 14 s). That ran Marketing's Shopify queries against
 * the same minute as this panel's, and Overview's money cards, and so the
 * switch, waited 18 s. Now they start SETTLE_MS after the panel has arrived,
 * STAGGER_MS apart, and a range changed meanwhile starts the queue again. A
 * pointer on a tab prefetches that tab at once. Next keeps each for 5 minutes.
 */
export function InsightsNav({ active, panels }: { active: InsightsPanel; panels: InsightsPanel[] }) {
  const t = useT();
  const params = useSearchParams();
  const router = useRouter();
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
  const others = INSIGHTS_PANELS.filter((panel) => panels.includes(panel.id) && panel.id !== active)
    .map((panel) => `${panel.href}${suffix}`)
    .join(" ");

  useEffect(() => {
    if (pending || !others) return;
    const timers = others.split(" ").map((href, i) => setTimeout(() => router.prefetch(href), SETTLE_MS + i * STAGGER_MS));
    return () => timers.forEach(clearTimeout);
  }, [others, pending, router]);

  return (
    <nav className={styles.nav} aria-label={t("insights.shell.panelsLabel")}>
      <ul className={styles.tabs}>
        {INSIGHTS_PANELS.filter((panel) => panels.includes(panel.id)).map((panel) => {
          const isCurrent = panel.id === current;
          const href = `${panel.href}${suffix}`;
          return (
            <li key={panel.id}>
              <Link
                href={href}
                prefetch={false}
                onPointerEnter={panel.id === active ? undefined : () => router.prefetch(href)}
                onFocus={panel.id === active ? undefined : () => router.prefetch(href)}
                className={`${styles.tab} ${isCurrent ? styles.tabActive : ""}`}
                aria-current={isCurrent ? "page" : undefined}
                onClick={(event: MouseEvent<HTMLAnchorElement>) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                  if (panel.id === active) return;
                  event.preventDefault();
                  setTarget(panel.id);
                  go(href, t(`insights.panel.${panel.id}`).toLowerCase());
                }}
              >
                {t(`insights.panel.${panel.id}`)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

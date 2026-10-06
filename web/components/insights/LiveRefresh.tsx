"use client";

import { useEffect, useRef } from "react";
import { useLocale, useT } from "@/lib/i18n/client";
import { intlTag } from "@/lib/i18n/locales";
import { useInsightsFrame } from "./InsightsFrame";
import styles from "./InsightsHeader.module.css";

/**
 * Keeps an open panel current without anyone pressing reload.
 *
 * Every five minutes while the tab is visible, and whenever the tab comes back
 * into view after more than a minute away, the page is re-rendered on the
 * server against the same URL. The data changes on the order sync and on each
 * mail poll, so a tighter loop would re-read identical rows; a hidden tab is
 * not polled at all.
 */
const INTERVAL_MS = 5 * 60_000;
const RETURN_AFTER_MS = 60_000;

export function LiveRefresh({ renderedAt }: { renderedAt: string }) {
  const t = useT();
  const locale = useLocale();
  const { refresh, pending } = useInsightsFrame();
  const renderedRef = useRef(Date.parse(renderedAt));
  renderedRef.current = Date.parse(renderedAt);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const timer = window.setInterval(tick, INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - renderedRef.current > RETURN_AFTER_MS) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  // The button asks for fresh figures: the cache is cleared first, then the
  // page re-rendered. The timer above only re-renders from the cache.
  const refreshFresh = () => {
    fetch("/api/insights/refresh", { method: "POST" })
      .catch(() => undefined)
      .finally(refresh);
  };

  const time = new Date(renderedAt).toLocaleTimeString(intlTag(locale), { hour: "2-digit", minute: "2-digit" });

  return (
    <div className={styles.live}>
      <span className={styles.liveDot} aria-hidden="true" />
      <span suppressHydrationWarning>{pending ? t("insights.shell.updating") : t("insights.shell.live", { time })}</span>
      <button type="button" className={styles.refresh} onClick={refreshFresh} disabled={pending} aria-label={t("insights.shell.refresh")}>
        <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );
}

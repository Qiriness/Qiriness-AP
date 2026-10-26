"use client";

import { usePathname, useSearchParams } from "next/navigation";
import type { InsightsPanel } from "@/lib/types";
import { DESK_ONLY_PANELS } from "@/lib/types";
import { useT } from "@/lib/i18n/client";
import { useInsightsFrame } from "./InsightsFrame";
import styles from "./InsightsHeader.module.css";

export interface SwitcherShop {
  slug: string;
  label: string;
  /** Only the support desk's shop has Support and AI agent. */
  desk: boolean;
}

/**
 * Which shop Insights shows. The same panel and period on the other shop: a
 * comparison is two clicks, not a re-navigation. A panel the other shop does not
 * have (Support, AI agent: there is no mailbox behind it) opens its Overview.
 * The address carries the shop (`?shop=`), and the middleware remembers it as
 * the one to open next time. Drawn only when there is more than one.
 */
export function ShopSwitcher({ shops, current, active }: { shops: SwitcherShop[]; current: string; active: InsightsPanel }) {
  const t = useT();
  const pathname = usePathname();
  const params = useSearchParams();
  const { go, pending } = useInsightsFrame();
  if (shops.length < 2) return null;

  const switchTo = (slug: string) => {
    const shop = shops.find((s) => s.slug === slug);
    if (!shop || slug === current) return;
    const next = new URLSearchParams(params?.toString() ?? "");
    next.set("shop", slug);
    const path = !shop.desk && (DESK_ONLY_PANELS as string[]).includes(active) ? "/insights/overview" : pathname;
    go(`${path}?${next.toString()}`, shop.label);
  };

  return (
    <label className={styles.selectWrap}>
      <span className={styles.srOnly}>{t("insights.shell.shopLabel")}</span>
      <select className={styles.select} value={current} disabled={pending} onChange={(event) => switchTo(event.target.value)}>
        {shops.map((shop) => (
          <option key={shop.slug} value={shop.slug}>
            {shop.label}
          </option>
        ))}
      </select>
    </label>
  );
}

import type { Freshness, InsightsPanel, InsightsRange, InsightsScope, PlatformId } from "@/lib/types";
import { getT } from "@/lib/i18n/server";
import { FreshnessStrip } from "@/components/ui/FreshnessStrip";
import { FilterBar } from "./FilterBar";
import { InsightsNav } from "./InsightsNav";
import { LiveRefresh } from "./LiveRefresh";
import { ShopSwitcher, type SwitcherShop } from "./ShopSwitcher";
import styles from "./InsightsHeader.module.css";

/**
 * Title, panel tabs, the filter row, and the line that says how current the
 * sources are. Server-rendered; the interactive pieces are client islands.
 */
export function InsightsHeader({
  active,
  panels,
  scope,
  range,
  platform,
  freshness,
  renderedAt,
  tzFallback,
  months,
  shops,
  shop,
}: {
  active: InsightsPanel;
  /** The panels this reader's role may open, and so the only tabs drawn. */
  panels: InsightsPanel[];
  scope: InsightsScope;
  range: InsightsRange | null;
  platform: PlatformId;
  freshness: Freshness | null;
  renderedAt: string | null;
  tzFallback: boolean;
  /** What the month picker offers. */
  months: { id: string; label: string }[];
  /** The shops Insights serves, for the switcher (drawn only with two or more). */
  shops: SwitcherShop[];
  /** The slug of the shop on screen. */
  shop: string;
}) {
  const t = getT();
  return (
    <header className={styles.header}>
      <div className={styles.titleRow}>
        <div className={styles.titleGroup}>
          <h1 className={styles.title}>{t("nav.insights")}</h1>
          <ShopSwitcher shops={shops} current={shop} active={active} />
        </div>
        {renderedAt ? <LiveRefresh renderedAt={renderedAt} /> : null}
      </div>
      <InsightsNav active={active} panels={panels} />
      {range ? <FilterBar range={range} platform={platform} scope={scope} months={months} /> : null}
      {freshness && freshness.items.length > 0 ? (
        <FreshnessStrip items={freshness.items} tzFallback={tzFallback} />
      ) : null}
    </header>
  );
}

"use client";

import type { AttributionModel, MarketingTab } from "@/lib/marketing-types";
import { useT } from "@/lib/i18n/client";
import { useInsightsFrame } from "./InsightsFrame";
import { Segmented } from "./Segmented";
import styles from "./MarketingTabsBar.module.css";

const MODELS: AttributionModel[] = ["lndc", "last", "first", "linear"];

/**
 * The panel's two tabs and, on Marketing, the attribution model. Both are URL
 * state (`?tab=funnel`, `?attr=first`), so a tab is linkable and the server
 * renders it; the range and platform above apply to both tabs.
 */
export function MarketingTabsBar({ tab, model }: { tab: MarketingTab; model: AttributionModel }) {
  const tr = useT();
  const { navigate } = useInsightsFrame();
  return (
    <div className={styles.bar}>
      <Segmented
        options={(["marketing", "funnel"] as MarketingTab[]).map((id) => ({ id, label: tr(`insights.mkt.tab.${id}`) }))}
        value={tab}
        onChange={(next) => navigate({ tab: next === "marketing" ? null : next, country: null })}
        label={tr("insights.mkt.tab.label")}
      />
      {tab === "marketing" ? (
        <label className={styles.model}>
          <span>{tr("insights.mkt.model.label")}</span>
          <select value={model} onChange={(e) => navigate({ attr: e.target.value === "lndc" ? null : e.target.value })}>
            {MODELS.map((m) => (
              <option key={m} value={m}>
                {tr(`insights.mkt.model.${m}`)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}

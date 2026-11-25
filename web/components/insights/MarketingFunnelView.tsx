import { Suspense } from "react";
import type { MarketingFunnelPanel, WebsitePerformancePanel } from "@/lib/marketing-types";
import type { Grain } from "@/lib/types";
import { getT } from "@/lib/i18n/server";
import { Await, BlockedCard, Card, Grid, LoadingNote } from "./InsightsKit";
import { MarketingPerformanceView } from "./MarketingPerformanceView";
import { MarketingTabsBar } from "./MarketingTabsBar";
import { WebsiteExplorer } from "./WebsiteExplorer";
import styles from "./MarketingFunnelView.module.css";

/**
 * Marketing & funnel: Marketing Performance (where the next euro of spend
 * goes) and Funnel & Website (where the next hour of website work goes), over
 * the range and platform above. Promotions moved to Sales on 2026-11-25.
 */
export function MarketingFunnelView({ panel, compareLabel, grain }: { panel: MarketingFunnelPanel; compareLabel: string; grain: Grain }) {
  return (
    <>
      <MarketingTabsBar tab={panel.tab} model={panel.tab === "marketing" ? panel.model : "lndc"} />
      {panel.tab === "marketing" ? (
        <MarketingPerformanceView panel={panel} compareLabel={compareLabel} grain={grain} />
      ) : (
        <WebsiteView panel={panel} compareLabel={compareLabel} />
      )}
    </>
  );
}

function WebsiteView({ panel, compareLabel }: { panel: WebsitePerformancePanel; compareLabel: string }) {
  const tr = getT();
  return (
    <>
      <Suspense
        fallback={
          <Card title={tr("insights.mkt.funnel.title")}>
            <LoadingNote />
          </Card>
        }
      >
        <Await promise={panel.performance}>
          {(part) =>
            part.blockedReason || !part.value ? (
              <Grid min={20}>
                <BlockedCard label={tr("insights.mkt.tab.funnel")} reason={part.blockedReason ?? "insights.mkt.state.unreadable"} />
              </Grid>
            ) : (
              <WebsiteExplorer data={part.value} compareLabel={compareLabel} />
            )
          }
        </Await>
      </Suspense>
      <TrackingGaps />
    </>
  );
}

/**
 * What this tab cannot measure yet, and what would measure it. Listed rather
 * than drawn as empty cards: each needs the web pixel (or a Klaviyo / cost
 * source) described in docs/marketing-funnel-redesign.md.
 */
function TrackingGaps() {
  const tr = getT();
  const items = ["productViews", "collectionViews", "collectionClicks", "journeys", "checkoutSteps", "pageRevenue", "pageRoas"];
  return (
    <Card title={tr("insights.mkt.gaps.title")} aside={<span>{tr("insights.mkt.gaps.aside")}</span>}>
      <ul className={styles.gaps}>
        {items.map((k) => (
          <li key={k}>
            <b>{tr(`insights.mkt.gaps.${k}.label`)}</b>
            <span>{tr(`insights.mkt.gaps.${k}.why`)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

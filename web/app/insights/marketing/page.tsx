import { InsightsPage } from "@/components/insights/InsightsPage";
import { MarketingFunnelView } from "@/components/insights/MarketingFunnelView";
import { getMarketingPanel, parseMarketingParams } from "@/lib/server/insights/marketing-service";
import type { SearchParams } from "@/lib/server/insights/context";

export const dynamic = "force-dynamic";

export const metadata = { title: "Marketing & funnel · Insights" };

export default function MarketingInsightsPage({ searchParams }: { searchParams: SearchParams }) {
  // The tab, the attribution model and the funnel's country live in the URL
  // like every other filter here (`?tab=funnel&attr=first&country=France`).
  const params = parseMarketingParams(searchParams);
  return (
    <InsightsPage
      active="marketing"
      scope={{ range: true, platform: true }}
      searchParams={searchParams}
      render={async (ctx) => (
        <MarketingFunnelView panel={await getMarketingPanel(ctx, params)} compareLabel={ctx.range.compareLabel} grain={ctx.range.grain} />
      )}
    />
  );
}

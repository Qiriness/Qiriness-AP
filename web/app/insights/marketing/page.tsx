import { InsightsPage } from "@/components/insights/InsightsPage";
import { MarketingView } from "@/components/insights/MarketingView";
import { getMarketingPanel } from "@/lib/server/insights/marketing-service";
import type { SearchParams } from "@/lib/server/insights/context";

export const dynamic = "force-dynamic";

export const metadata = { title: "Marketing & funnel · Insights · Qiriness Support OS" };

export default function MarketingInsightsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <InsightsPage
      active="marketing"
      scope={{ range: true, platform: true }}
      searchParams={searchParams}
      render={async (ctx) => <MarketingView
          panel={await getMarketingPanel(ctx)}
          compareLabel={ctx.range.compareLabel}
          grain={ctx.range.grain}
        />}
    />
  );
}

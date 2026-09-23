import { InsightsPage } from "@/components/insights/InsightsPage";
import { OverviewView } from "@/components/insights/OverviewView";
import { getOverviewPanel } from "@/lib/server/insights/overview-service";
import type { SearchParams } from "@/lib/server/insights/context";

export const dynamic = "force-dynamic";

export const metadata = { title: "Overview · Insights · Qiriness Support OS" };

export default function OverviewInsightsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <InsightsPage
      active="overview"
      scope={{ range: true, platform: true }}
      searchParams={searchParams}
      render={async (ctx) => <OverviewView panel={await getOverviewPanel(ctx)} compareLabel={ctx.range.compareLabel} />}
    />
  );
}

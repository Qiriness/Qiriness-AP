import { InsightsPage } from "@/components/insights/InsightsPage";
import { SupportView } from "@/components/insights/SupportView";
import { getSupportPanel } from "@/lib/server/insights/support-service";
import type { SearchParams } from "@/lib/server/insights/context";

export const dynamic = "force-dynamic";

export const metadata = { title: "Support · Insights · Qiriness Support OS" };

export default function SupportInsightsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <InsightsPage
      active="support"
      scope={{ range: true, platform: false }}
      searchParams={searchParams}
      render={async (ctx) => <SupportView panel={await getSupportPanel(ctx)} compareLabel={ctx.range.compareLabel} />}
    />
  );
}

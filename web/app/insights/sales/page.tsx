import { InsightsPage } from "@/components/insights/InsightsPage";
import { SalesView } from "@/components/insights/SalesView";
import { getSalesPanel } from "@/lib/server/insights/sales-service";
import type { SearchParams } from "@/lib/server/insights/context";

export const dynamic = "force-dynamic";

export const metadata = { title: "Sales · Insights · Qiriness Support OS" };

export default function SalesInsightsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <InsightsPage
      active="sales"
      scope={{ range: true, platform: true }}
      searchParams={searchParams}
      render={async (ctx) => <SalesView panel={await getSalesPanel(ctx)} compareLabel={ctx.range.compareLabel} />}
    />
  );
}

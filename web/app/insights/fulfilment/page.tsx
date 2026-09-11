import { InsightsPage } from "@/components/insights/InsightsPage";
import { FulfilmentView } from "@/components/insights/FulfilmentView";
import { getFulfilmentPanel } from "@/lib/server/insights/fulfilment-service";
import type { SearchParams } from "@/lib/server/insights/context";

export const dynamic = "force-dynamic";

export const metadata = { title: "Fulfilment · Insights · Qiriness Support OS" };

export default function FulfilmentInsightsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <InsightsPage
      active="fulfilment"
      scope={{ range: true, platform: true }}
      searchParams={searchParams}
      render={async (ctx) => (
        <FulfilmentView panel={await getFulfilmentPanel(ctx)} compareLabel={ctx.range.compareLabel} />
      )}
    />
  );
}

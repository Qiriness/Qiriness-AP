import { InsightsPage } from "@/components/insights/InsightsPage";
import { SalesView } from "@/components/insights/SalesView";
import { getSalesPanel } from "@/lib/server/insights/sales-service";
import type { SearchParams } from "@/lib/server/insights/context";

export const dynamic = "force-dynamic";

export const metadata = { title: "Sales · Insights · Qiriness Support OS" };

export default function SalesInsightsPage({ searchParams }: { searchParams: SearchParams }) {
  // The product card's selection and filters live in the URL like every other
  // filter here. The service validates them against what the range holds.
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const productMix = {
    productId: first(searchParams.product) ?? null,
    country: first(searchParams.mixCountry)?.trim().toUpperCase() || null,
    vipOnly: first(searchParams.mixVip) === "1",
  };
  return (
    <InsightsPage
      active="sales"
      scope={{ range: true, platform: true }}
      searchParams={searchParams}
      render={async (ctx) => (
        <SalesView panel={await getSalesPanel(ctx, productMix, { vipOnly: first(searchParams.bestVip) === "1" })} compareLabel={ctx.range.compareLabel} />
      )}
    />
  );
}

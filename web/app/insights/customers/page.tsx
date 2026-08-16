import { AppShell } from "@/components/app-shell/AppShell";
import { InsightsNav } from "@/components/insights/InsightsNav";
import { CustomersView } from "@/components/insights/CustomersView";
import { PanelError } from "@/components/insights/InsightsKit";
import { getShopId } from "@/lib/server/knowledge-service";
import { getCustomersPanel } from "@/lib/server/insights/customers-service";
import type { CustomerPanel } from "@/lib/types";

export const dynamic = "force-dynamic";

export const metadata = { title: "Customers · Insights · Qiriness Support OS" };

/**
 * A Server Component, like every other Insights route: the reads use the
 * service-role key and must never cross into the browser, and the panel paints
 * with real figures instead of flashing empty tiles.
 *
 * The view underneath IS a client component — the call list re-sorts — but it is
 * handed a finished `CustomerPanel` rather than a fetcher, so the boundary
 * carries plain data and nothing server-only follows it across.
 */
export default async function CustomersInsightsPage() {
  let panel: CustomerPanel | null = null;
  let loadError: string | null = null;

  try {
    panel = await getCustomersPanel(await getShopId());
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load customer insights.";
  }

  return (
    <AppShell activeHref="/insights">
      <InsightsNav active="customers" />
      {loadError || !panel ? (
        <PanelError message={loadError ?? "No data returned."} />
      ) : (
        <CustomersView panel={panel} />
      )}
    </AppShell>
  );
}

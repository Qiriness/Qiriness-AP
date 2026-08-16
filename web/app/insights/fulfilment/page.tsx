import { AppShell } from "@/components/app-shell/AppShell";
import { InsightsNav } from "@/components/insights/InsightsNav";
import { FulfilmentView } from "@/components/insights/FulfilmentView";
import { PanelError } from "@/components/insights/InsightsKit";
import { getShopId } from "@/lib/server/knowledge-service";
import { getFulfilmentPanel } from "@/lib/server/insights/fulfilment-service";
import type { FulfilmentPanel } from "@/lib/types";

export const dynamic = "force-dynamic";

export const metadata = { title: "Fulfilment · Insights · Qiriness Support OS" };

/**
 * Loads server-side like every other surface here, so the panel paints with
 * real figures rather than flashing empty tiles. There is nothing to filter
 * client-side: each figure is one row from one aggregate view.
 */
export default async function FulfilmentInsightsPage() {
  let panel: FulfilmentPanel | null = null;
  let loadError: string | null = null;

  try {
    panel = await getFulfilmentPanel(await getShopId());
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load fulfilment insights.";
  }

  return (
    <AppShell activeHref="/insights">
      <InsightsNav active="fulfilment" />
      {loadError || !panel ? (
        <PanelError message={loadError ?? "No data returned."} />
      ) : (
        <FulfilmentView panel={panel} />
      )}
    </AppShell>
  );
}

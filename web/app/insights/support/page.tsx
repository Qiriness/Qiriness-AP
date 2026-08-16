import { AppShell } from "@/components/app-shell/AppShell";
import { InsightsNav } from "@/components/insights/InsightsNav";
import { PanelError } from "@/components/insights/InsightsKit";
import { SupportView } from "@/components/insights/SupportView";
import { getShopId } from "@/lib/server/knowledge-service";
import { getSupportPanel } from "@/lib/server/insights/support-service";
import type { SupportPanel } from "@/lib/types";

export const dynamic = "force-dynamic";

export const metadata = { title: "Support - Insights - Qiriness Support OS" };

export default async function SupportInsightsPage() {
  let panel: SupportPanel | null = null;
  let loadError: string | null = null;

  try {
    panel = await getSupportPanel(await getShopId());
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load support insights.";
  }

  return (
    <AppShell activeHref="/insights">
      <InsightsNav active="support" />
      {loadError || !panel ? (
        <PanelError message={loadError ?? "No data returned."} />
      ) : (
        <SupportView panel={panel} />
      )}
    </AppShell>
  );
}

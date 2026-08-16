import { AppShell } from "@/components/app-shell/AppShell";
import { InsightsNav } from "@/components/insights/InsightsNav";
import { AgentView } from "@/components/insights/AgentView";
import { PanelError } from "@/components/insights/InsightsKit";
import { getShopId } from "@/lib/server/knowledge-service";
import { getAgentPanel } from "@/lib/server/insights/agent-service";
import type { AgentPanel } from "@/lib/types";

export const dynamic = "force-dynamic";

export const metadata = { title: "Agent · Insights · Qiriness Support OS" };

export default async function AgentInsightsPage() {
  let panel: AgentPanel | null = null;
  let loadError: string | null = null;

  try {
    panel = await getAgentPanel(await getShopId());
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load agent insights.";
  }

  return (
    <AppShell activeHref="/insights">
      <InsightsNav active="agent" />
      {loadError || !panel ? (
        <PanelError message={loadError ?? "No data returned."} />
      ) : (
        <AgentView panel={panel} />
      )}
    </AppShell>
  );
}

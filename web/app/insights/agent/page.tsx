import { InsightsPage } from "@/components/insights/InsightsPage";
import { AgentView } from "@/components/insights/AgentView";
import { getAgentPanel } from "@/lib/server/insights/agent-service";
import type { SearchParams } from "@/lib/server/insights/context";

export const dynamic = "force-dynamic";

export const metadata = { title: "AI agent · Insights · Qiriness Support OS" };

export default function AgentInsightsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <InsightsPage
      active="agent"
      scope={{ range: true, platform: false }}
      searchParams={searchParams}
      render={async (ctx) => <AgentView panel={await getAgentPanel(ctx)} compareLabel={ctx.range.compareLabel} />}
    />
  );
}

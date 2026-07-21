import { AppShell } from "@/components/app-shell/AppShell";
import { AgentSetup } from "@/components/agent-setup/AgentSetup";

export default function AgentSetupPage() {
  return (
    <AppShell activeHref="/agent-setup">
      <AgentSetup />
    </AppShell>
  );
}

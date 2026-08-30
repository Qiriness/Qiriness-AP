import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell/AppShell";
import { SetupTabs } from "@/components/agent-setup/SetupTabs";
import { openConversationCount } from "@/lib/server/conversation-badge";

export const dynamic = "force-dynamic";

/**
 * The shell and the tab bar, shared by all three setup screens.
 *
 * A LAYOUT RATHER THAN A COMPONENT IN EACH PAGE, so the three cannot drift into
 * showing different navigation — which is the whole failure a tab bar exists to
 * prevent. It also means `openConversationCount()` is fetched once per
 * navigation between them instead of once per page.
 */
export default async function AgentSetupLayout({ children }: { children: ReactNode }) {
  const openConversations = await openConversationCount();

  return (
    <AppShell activeHref="/agent-setup" openConversations={openConversations}>
      <SetupTabs />
      {children}
    </AppShell>
  );
}

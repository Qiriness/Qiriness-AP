import { AppShell } from "@/components/app-shell/AppShell";
import { SettingsView, type SettingsMe, type SettingsTab } from "@/components/settings/SettingsView";
import { getAgentRoster } from "@/lib/server/agent-settings-service";
import { getSession } from "@/lib/server/auth";
import { navBadgeCounts } from "@/lib/server/conversation-badge";
import { ROLE_LABELS, canAccessPath } from "../../../scripts/lib/dashboard-auth.mjs";

export const dynamic = "force-dynamic";

/** The areas "My info" reports access to, in sidebar order. */
const AREAS = [
  { label: "Home chat", path: "/home" },
  { label: "Tickets", path: "/tickets" },
  { label: "Conversations", path: "/conversations" },
  { label: "Orders", path: "/orders" },
  { label: "Insights — Overview, Sales, Marketing & sales report", path: "/insights/sales" },
  { label: "Insights — other panels", path: "/insights/fulfilment" },
  { label: "Agent Setup", path: "/agent-setup" },
];

/**
 * Settings: two tabs, held in the URL (`?tab=agents`) so each can be linked.
 * Only the open tab's data is read — the agent table costs two queries that
 * My info has no use for.
 */
export default async function SettingsPage({ searchParams }: { searchParams?: { tab?: string } }) {
  const tab: SettingsTab = searchParams?.tab === "agents" ? "agents" : "me";
  const [badges, user, roster] = await Promise.all([
    navBadgeCounts(),
    getSession(),
    tab === "agents" ? getAgentRoster() : Promise.resolve(null),
  ]);

  const me: SettingsMe | null = user
    ? {
        name: user.displayName,
        email: user.email,
        roleLabel: ROLE_LABELS[user.role] ?? user.role,
        access: AREAS.map((area) => ({ label: area.label, allowed: canAccessPath(user.role, area.path) })),
      }
    : null;

  return (
    <AppShell activeHref="/settings" {...badges}>
      <SettingsView tab={tab} me={me} roster={roster} />
    </AppShell>
  );
}

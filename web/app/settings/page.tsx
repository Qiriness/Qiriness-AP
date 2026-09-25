import { AppShell } from "@/components/app-shell/AppShell";
import { SettingsView, type SettingsMe, type SettingsTab } from "@/components/settings/SettingsView";
import { getAgentRoster } from "@/lib/server/agent-settings-service";
import { getSession } from "@/lib/server/auth";
import { navBadgeCounts } from "@/lib/server/conversation-badge";
import { getKlaviyoStatus } from "@/lib/server/integrations-service";
import { ROLE_LABELS, canAccessPath, canManageIntegrations } from "../../../scripts/lib/dashboard-auth.mjs";

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
 * Settings: three tabs, held in the URL (`?tab=agents`, `?tab=integrations`)
 * so each can be linked. Only the open tab's data is read — the agent table
 * costs two queries that My info has no use for. Integrations is not drawn for
 * the contact team, and its URL falls back to My info for them.
 */
export default async function SettingsPage({ searchParams }: { searchParams?: { tab?: string } }) {
  const asked = searchParams?.tab;
  const [badges, user] = await Promise.all([navBadgeCounts(), getSession()]);
  const integrations = Boolean(user && canManageIntegrations(user.role));
  const tab: SettingsTab = asked === "agents" ? "agents" : asked === "integrations" && integrations ? "integrations" : "me";
  const [roster, klaviyo] = await Promise.all([
    tab === "agents" ? getAgentRoster() : Promise.resolve(null),
    tab === "integrations"
      ? getKlaviyoStatus().catch((error: unknown) => ({
          error: error instanceof Error ? error.message : "Could not read the Klaviyo connection.",
        }))
      : Promise.resolve(null),
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
      <SettingsView tab={tab} me={me} roster={roster} klaviyo={klaviyo} canManageIntegrations={integrations} />
    </AppShell>
  );
}

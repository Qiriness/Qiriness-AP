import { AppShell } from "@/components/app-shell/AppShell";
import { SettingsView, type SettingsMe, type SettingsTab } from "@/components/settings/SettingsView";
import { getAgentRoster } from "@/lib/server/agent-settings-service";
import { getSession } from "@/lib/server/auth";
import { navBadgeCounts } from "@/lib/server/conversation-badge";
import { getKlaviyoStatus } from "@/lib/server/integrations-service";
import { canAccessPath, canChooseAgentModels, canManageIntegrations } from "../../../scripts/lib/dashboard-auth.mjs";

export const dynamic = "force-dynamic";

/** The areas "My info" reports access to, in sidebar order. */
const AREAS = [
  { id: "home", path: "/home" },
  { id: "tickets", path: "/tickets" },
  { id: "conversations", path: "/conversations" },
  { id: "orders", path: "/orders" },
  { id: "insightsMoney", path: "/insights/sales" },
  { id: "insightsOther", path: "/insights/fulfilment" },
  { id: "agentSetup", path: "/agent-setup" },
];

/**
 * Settings: four tabs, held in the URL (`?tab=agents`, `?tab=integrations`,
 * `?tab=dev`) so each can be linked. Only the open tab's data is read — the
 * agent table costs two queries that My info has no use for (Dev info reuses
 * it for the OpenAI models and spend). Integrations and Dev info are not drawn
 * for the contact team, and their URLs fall back to My info for them.
 */
export default async function SettingsPage({ searchParams }: { searchParams?: { tab?: string } }) {
  const asked = searchParams?.tab;
  const [badges, user] = await Promise.all([navBadgeCounts(), getSession()]);
  const integrations = Boolean(user && canManageIntegrations(user.role));
  const tab: SettingsTab =
    asked === "agents" ? "agents" : asked === "integrations" && integrations ? "integrations" : asked === "dev" && integrations ? "dev" : "me";
  const [roster, klaviyo] = await Promise.all([
    tab === "agents" || tab === "dev" ? getAgentRoster() : Promise.resolve(null),
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
        role: user.role,
        access: AREAS.map((area) => ({ id: area.id, allowed: canAccessPath(user.role, area.path) })),
      }
    : null;

  return (
    <AppShell activeHref="/settings" {...badges}>
      <SettingsView
        tab={tab}
        me={me}
        roster={roster}
        klaviyo={klaviyo}
        canManageIntegrations={integrations}
        canChooseModels={Boolean(user && canChooseAgentModels(user.role))}
      />
    </AppShell>
  );
}

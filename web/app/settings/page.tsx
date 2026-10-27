import { AppShell } from "@/components/app-shell/AppShell";
import { SettingsView, type SettingsMe, type SettingsTab } from "@/components/settings/SettingsView";
import type { MailSetting } from "@/components/settings/MailSettingsCard";
import { getAgentRoster } from "@/lib/server/agent-settings-service";
import { getSession } from "@/lib/server/auth";
import { navBadgeCounts } from "@/lib/server/conversation-badge";
import { integrationShopForSlug } from "@/lib/server/integration-shop";
import { getSupabaseClient } from "@/lib/server/insights/shared";
import { readMailSettings } from "../../../scripts/lib/shop-mail-settings.mjs";
import { getKlaviyoStatus } from "@/lib/server/integrations-service";
import { insightsShopFor } from "@/lib/server/insights/context";
import { getSocialConnections } from "@/lib/server/social-connections-service";
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
 *
 * THE SHOP IS IN THE ADDRESS (`?shop=`), as on Insights: the sidebar picks it
 * and the middleware fills it in. Integrations are that shop's; Agent settings
 * and Dev info are the support desk's agents, so they are drawn only on the
 * desk shop.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams?: { tab?: string; connected?: string; connect_error?: string; provider?: string; shop?: string };
}) {
  const asked = searchParams?.tab;
  const selected = insightsShopFor({ shop: searchParams?.shop });
  const [badges, user] = await Promise.all([navBadgeCounts(), getSession()]);
  const integrations = Boolean(user && canManageIntegrations(user.role));
  const tab: SettingsTab =
    asked === "agents" && selected.desk
      ? "agents"
      : asked === "integrations" && integrations
        ? "integrations"
        : asked === "dev" && integrations && selected.desk
          ? "dev"
          : "me";
  const shopRead = tab === "integrations" ? integrationShopForSlug(selected.slug) : null;
  const shopId = async () => (await shopRead!).id;
  const [roster, klaviyo, social, shopRow, mail] = await Promise.all([
    tab === "agents" || tab === "dev" ? getAgentRoster() : Promise.resolve(null),
    tab === "integrations"
      ? shopId().then(getKlaviyoStatus).catch((error: unknown) => ({
          error: error instanceof Error ? error.message : "Could not read the Klaviyo connection.",
        }))
      : Promise.resolve(null),
    tab === "integrations"
      ? shopId().then(getSocialConnections).catch((error: unknown) => ({
          error: error instanceof Error ? error.message : "Could not read the social connections.",
        }))
      : Promise.resolve(null),
    shopRead ? shopRead.catch(() => null) : Promise.resolve(null),
    tab === "integrations" ? shopId().then((id) => readMailSettings(getSupabaseClient(), id)).catch(() => null) : Promise.resolve(null),
  ]);
  // Where a provider sends the person back after Connect (social-return.ts).
  const socialNotice = searchParams?.connected
    ? { ok: true as const, provider: searchParams.connected }
    : searchParams?.connect_error
      ? { ok: false as const, code: searchParams.connect_error, provider: searchParams.provider ?? null }
      : null;

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
        shop={{ slug: selected.slug, desk: selected.desk, name: shopRow?.shopName ?? selected.slug }}
        me={me}
        roster={roster}
        klaviyo={klaviyo}
        social={social}
        socialNotice={socialNotice}
        mail={mail as Record<"sales_report" | "stock_alert", MailSetting> | null}
        canManageIntegrations={integrations}
        canChooseModels={Boolean(user && canChooseAgentModels(user.role))}
      />
    </AppShell>
  );
}

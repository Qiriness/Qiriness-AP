import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { canAccessPath, fallbackPath } from "../../../scripts/lib/dashboard-auth.mjs";
import { AppShell } from "@/components/app-shell/AppShell";
import { InsightsFrame } from "@/components/insights/InsightsFrame";
import { Card, EmptyState, PanelError, SectionLabel } from "@/components/insights/InsightsKit";
import { LiveRefresh } from "@/components/insights/LiveRefresh";
import headerStyles from "@/components/insights/InsightsHeader.module.css";
import { AgentFilters } from "@/components/storefront-agent/AgentFilters";
import { StorefrontAgentView } from "@/components/storefront-agent/StorefrontAgentView";
import { ChatCapsCard } from "@/components/storefront-agent/ChatCapsCard";
import { getChatCaps, type ChatCapsView } from "@/lib/server/storefront-agent/chat-caps-service";
import { getSession } from "@/lib/server/auth";
import { navBadgeCounts } from "@/lib/server/conversation-badge";
import { timed } from "@/lib/server/timing";
import { AGENT_PRESETS, advisorShops, getStorefrontAgentDashboard, resolveAgentRange } from "@/lib/server/storefront-agent/dashboard-service";
import type { SearchParams } from "@/lib/server/insights/context";
import { getLocale, getT } from "@/lib/i18n/server";
import { compareLabel, rangeLabel } from "@/lib/insights-labels";
import type { InsightsRange } from "@/lib/types";

export const dynamic = "force-dynamic";

export const metadata = { title: "Storefront Agent · Dashboard" };

/**
 * Storefront Agent → Dashboard: how the storefront advisor is used, what it
 * sells, how well and how fast it answers, and what it costs, over 7, 30 or 90
 * days or a custom period, each figure against the period before.
 *
 * Reads `storefront_agent_dashboard` (migration 07) through
 * dashboard-service.ts; the tracking that feeds it lives with the chat service
 * (turn-metrics.mjs, the event route, the widget), never here.
 *
 * THE CHAT'S CAPS are edited at the foot of the page (chat-caps.mjs), read on
 * their own so a failed dashboard still leaves them reachable.
 */
export default async function StorefrontAgentPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!canAccessPath(session.role, "/storefront-agent")) redirect(fallbackPath(session.role));

  const badgesRead = timed("storefront agent badges", navBadgeCounts());
  const t = getT();
  const locale = getLocale();
  const shops = advisorShops();
  let range: InsightsRange | null = null;
  let body: ReactNode;
  let renderedAt: string | null = null;

  if (!shops.length) {
    body = <EmptyState>{t("storefrontAgent.notConfigured")}</EmptyState>;
  } else {
    const capsRead: Promise<ChatCapsView[] | null> = getChatCaps(shops).catch((error: unknown) => {
      console.error("[storefront agent] caps failed", error instanceof Error ? error.message : error);
      return null;
    });
    try {
      const resolved = await resolveAgentRange(searchParams, shops);
      range = { ...resolved, label: rangeLabel(resolved, t, locale), compareLabel: compareLabel(resolved, t, locale) };
      const data = await timed(`storefront agent dashboard (${range.preset})`, getStorefrontAgentDashboard(range, shops, locale));
      renderedAt = new Date().toISOString();
      body = <StorefrontAgentView data={data} />;
    } catch (error) {
      console.error("[storefront agent] dashboard failed", error instanceof Error ? error.message : error);
      body = <PanelError message={t("storefrontAgent.loadFailed")} />;
    }
    const caps = await capsRead;
    body = (
      <>
        {body}
        <SectionLabel>{t("storefrontAgent.s.caps")}</SectionLabel>
        <Card title={t("storefrontAgent.caps.title")}>
          {caps ? (
            caps.map((c) => <ChatCapsCard key={c.shopDomain} caps={c} showShop={caps.length > 1} />)
          ) : (
            <PanelError message={t("storefrontAgent.caps.loadFailed")} />
          )}
        </Card>
      </>
    );
  }

  const header = (
    <header className={headerStyles.header}>
      <div className={headerStyles.titleRow}>
        <div className={headerStyles.titleGroup}>
          <h1 className={headerStyles.title}>
            {t("storefrontAgent.title")} · {t("storefrontAgent.subtitle")}
          </h1>
        </div>
        {renderedAt ? <LiveRefresh renderedAt={renderedAt} /> : null}
      </div>
      {range ? <AgentFilters range={range} presets={AGENT_PRESETS} /> : null}
      {shops.length ? <p className={headerStyles.srOnly}>{t("storefrontAgent.shops", { shops: shops.join(", ") })}</p> : null}
    </header>
  );

  return (
    <AppShell activeHref="/storefront-agent" {...await badgesRead}>
      <InsightsFrame panel="storefront-agent" header={header}>
        {body}
      </InsightsFrame>
    </AppShell>
  );
}

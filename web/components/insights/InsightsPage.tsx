import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { canSeePanel, fallbackPath } from "../../../scripts/lib/dashboard-auth.mjs";
import { AppShell } from "@/components/app-shell/AppShell";
import { getSession } from "@/lib/server/auth";
import { navBadgeCounts } from "@/lib/server/conversation-badge";
import { timed } from "@/lib/server/timing";
import { resolveInsightsContext, type InsightsContext, type SearchParams } from "@/lib/server/insights/context";
import { INSIGHTS_PANELS, type InsightsPanel, type InsightsScope } from "@/lib/types";
import { InsightsFrame } from "./InsightsFrame";
import { InsightsHeader } from "./InsightsHeader";
import { PanelError } from "./InsightsKit";

/**
 * What every Insights route is: the shell, the header, and one panel rendered
 * from the context the URL resolves to. A failed read renders the panel's error
 * inside the frame rather than a blank page, with the filters still usable.
 *
 * THE ROLE IS CHECKED HERE AS WELL AS IN THE MIDDLEWARE. The middleware keeps
 * the URL out of reach; this keeps the panel from rendering if a route is ever
 * added that the middleware's path rule does not cover, and it decides which
 * tabs are drawn at all — a tab the reader cannot open is not shown.
 */
export async function InsightsPage({
  active,
  scope,
  searchParams,
  render,
}: {
  active: InsightsPanel;
  scope: InsightsScope;
  searchParams: SearchParams;
  render: (ctx: InsightsContext) => Promise<ReactNode>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!canSeePanel(session.role, active)) redirect(fallbackPath(session.role));
  const panels = INSIGHTS_PANELS.filter((panel) => canSeePanel(session.role, panel.id)).map((panel) => panel.id);

  // Started, not awaited: the sidebar badges are read beside the panel rather
  // than before it. navBadgeCounts never throws.
  const badgesRead = timed("insights badges", navBadgeCounts());
  let ctx: InsightsContext | null = null;
  let body: ReactNode = null;
  let error: string | null = null;

  try {
    ctx = await timed(`insights ${active} context`, resolveInsightsContext(searchParams));
    body = await timed(`insights ${active} panel (${ctx.range.preset})`, render(ctx));
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load this panel.";
  }
  const badges = await badgesRead;

  return (
    <AppShell activeHref="/insights" {...badges}>
      <InsightsFrame
        panel={active}
        header={
          <InsightsHeader
            active={active}
            panels={panels}
            scope={scope}
            range={ctx?.range ?? null}
            platform={ctx?.platform ?? "all"}
            freshness={ctx?.freshness ?? null}
            renderedAt={ctx?.renderedAt ?? null}
            tzFallback={ctx?.tzFallback ?? false}
          />
        }
      >
        {error ? <PanelError message={error} /> : body}
      </InsightsFrame>
    </AppShell>
  );
}

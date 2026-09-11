import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell/AppShell";
import { openConversationCount } from "@/lib/server/conversation-badge";
import { resolveInsightsContext, type InsightsContext, type SearchParams } from "@/lib/server/insights/context";
import type { InsightsPanel, InsightsScope } from "@/lib/types";
import { InsightsFrame } from "./InsightsFrame";
import { InsightsHeader } from "./InsightsHeader";
import { PanelError } from "./InsightsKit";

/**
 * What every Insights route is: the shell, the header, and one panel rendered
 * from the context the URL resolves to. A failed read renders the panel's error
 * inside the frame rather than a blank page, with the filters still usable.
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
  const openConversations = await openConversationCount();
  let ctx: InsightsContext | null = null;
  let body: ReactNode = null;
  let error: string | null = null;

  try {
    ctx = await resolveInsightsContext(searchParams);
    body = await render(ctx);
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load this panel.";
  }

  return (
    <AppShell activeHref="/insights" openConversations={openConversations}>
      <InsightsFrame
        panel={active}
        header={
          <InsightsHeader
            active={active}
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

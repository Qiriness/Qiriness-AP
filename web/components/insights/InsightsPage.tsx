import { Fragment, type ReactNode } from "react";
import { redirect } from "next/navigation";
import { canSeePanel, fallbackPath } from "../../../scripts/lib/dashboard-auth.mjs";
import { AppShell } from "@/components/app-shell/AppShell";
import { getSession } from "@/lib/server/auth";
import { getLocale, getT } from "@/lib/i18n/server";
import { compareLabel, monthLabelL, rangeLabel } from "@/lib/insights-labels";
import { navBadgeCounts } from "@/lib/server/conversation-badge";
import { timed } from "@/lib/server/timing";
import { resolveInsightsContext, type InsightsContext, type SearchParams } from "@/lib/server/insights/context";
import { INSIGHTS_PANELS, type InsightsPanel, type InsightsScope } from "@/lib/types";
import { InsightsFrame } from "./InsightsFrame";
import { InsightsHeader } from "./InsightsHeader";
import { PanelError } from "./InsightsKit";

/** The URL keys that choose the period and platform: the panel's identity. */
const PERIOD_KEYS = ["range", "month", "from", "to", "platform"];

/**
 * A NEW PERIOD IS A NEW PANEL, not an update of the old one. Under the same key,
 * React keeps a Suspense boundary that is already showing content, so a range
 * switch waited for the slowest Shopify card before anything moved (1 year:
 * 18 s, 2026-10-26, against 0.9 s of the panel's own reads). Under a new key the
 * switch lands with the database figures and each Shopify card shows its loading
 * state until it answers. Only the period keys: a filter inside a panel (the
 * product picked on Sales) keeps the panel and its search box as they are.
 */
function periodKey(searchParams: SearchParams): string {
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";
  return PERIOD_KEYS.map((key) => `${key}=${first(searchParams[key])}`).join("&");
}

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
    const resolved = await timed(`insights ${active} context`, resolveInsightsContext(searchParams));
    // The shared range module words periods in English (the monthly report reads
    // it too); the dashboard rebuilds them from the range's own fields.
    const locale = getLocale();
    const t = getT(locale);
    ctx = {
      ...resolved,
      range: {
        ...resolved.range,
        label: rangeLabel(resolved.range, t, locale),
        compareLabel: compareLabel(resolved.range, t, locale),
      },
      months: resolved.months.map((month) => ({
        ...month,
        label: monthLabelL(new Date(`${month.id}-01T00:00:00Z`), locale),
      })),
    };
    body = await timed(`insights ${active} panel (${ctx.range.preset})`, render(ctx));
  } catch (e) {
    error = e instanceof Error ? e.message : getT()("insights.shell.loadFailed");
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
            months={ctx?.months ?? []}
          />
        }
      >
        {error ? <PanelError message={error} /> : <Fragment key={periodKey(searchParams)}>{body}</Fragment>}
      </InsightsFrame>
    </AppShell>
  );
}

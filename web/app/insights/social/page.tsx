import { InsightsPage } from "@/components/insights/InsightsPage";
import { SocialView } from "@/components/insights/SocialView";
import { getSocialPanel, parseSocialParams } from "@/lib/server/insights/social-service";
import type { SearchParams } from "@/lib/server/insights/context";

export const dynamic = "force-dynamic";

export const metadata = { title: "Social media · Insights" };

export default function SocialInsightsPage({ searchParams }: { searchParams: SearchParams }) {
  const params = parseSocialParams(searchParams);
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  return (
    <InsightsPage
      active="social"
      scope={{ range: true, platform: false, platformReason: "insights.social.platformReason" }}
      searchParams={searchParams}
      render={async (ctx) => (
        <SocialView
          panel={await getSocialPanel(ctx, params)}
          compareLabel={ctx.range.compareLabel}
          openConnections={first(searchParams.connections) === "1"}
          connected={first(searchParams.connected) ?? null}
          connectError={first(searchParams.connect_error) ?? null}
          connectProvider={first(searchParams.provider) ?? null}
        />
      )}
    />
  );
}

import { AppShell } from "@/components/app-shell/AppShell";
import { AgentSetup } from "@/components/agent-setup/AgentSetup";
import { getShopId, listArticles, listShopifySources } from "@/lib/server/knowledge-service";
import { mapArticleResponse, mapSourceResponse } from "@/lib/knowledge-mapper";
import type { Article, ShopifySource } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Fetches the initial article/source lists server-side (same process, no
 * HTTP round-trip) so the dashboard renders with real data on first paint
 * instead of flashing empty. Subsequent mutations go through the Knowledge
 * API client-side (web/lib/api/knowledge.ts).
 */
export default async function AgentSetupPage() {
  let initialArticles: Article[] = [];
  let initialSources: ShopifySource[] = [];
  let loadError: string | null = null;

  try {
    const shopId = await getShopId();
    const [articles, sources] = await Promise.all([listArticles(shopId), listShopifySources(shopId)]);
    initialArticles = articles.map(mapArticleResponse);
    initialSources = sources.map(mapSourceResponse);
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load knowledge data.";
  }

  return (
    <AppShell activeHref="/agent-setup">
      <AgentSetup
        initialArticles={initialArticles}
        initialSources={initialSources}
        loadError={loadError}
      />
    </AppShell>
  );
}

import { RecommendationList } from "@/components/agent-setup/RecommendationList";
import {
  concernOptions,
  getShopId,
  listRecommendable,
} from "@/lib/server/recommendations-service";
import { listCollections } from "@/lib/server/collections-service";
import type { ConcernOption, RecommendableProduct } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Fetched server-side like the other setup screens: the catalogue is 90 rows and
 * rendering it empty first would read as "nothing to curate", which is the one
 * wrong impression this screen can give.
 */
export default async function RecommendationsPage() {
  let products: RecommendableProduct[] = [];
  let concerns: ConcernOption[] = [];
  let loadError: string | null = null;

  try {
    const shopId = await getShopId();
    products = await listRecommendable(shopId);
    // The live collections join the five skin concerns as things a product can
    // be ticked for. A tick on a collection only REORDERS what the intersection
    // already chose, so an untouched one is the shop having no preference rather
    // than a gap — which is why they are listed beside the concerns and not as a
    // second screen.
    concerns = concernOptions(products, await listCollections(shopId));
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load the catalogue.";
  }

  return (
    <RecommendationList
      initialProducts={products}
      initialConcerns={concerns}
      loadError={loadError}
    />
  );
}

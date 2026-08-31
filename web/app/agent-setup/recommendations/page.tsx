import { RecommendationList } from "@/components/agent-setup/RecommendationList";
import {
  concernOptions,
  getShopId,
  listRecommendable,
} from "@/lib/server/recommendations-service";
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
    products = await listRecommendable(await getShopId());
    concerns = concernOptions(products);
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

import { CollectionList } from "@/components/agent-setup/CollectionList";
import { getShopId, listCollections } from "@/lib/server/collections-service";
import type { AdviceCollection } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Which Shopify collections support may answer advice from.
 *
 * Fetched server-side like the other setup screens. It matters more here than
 * elsewhere: an empty first paint on this page reads as "nothing is curated",
 * which is a claim about the shop rather than a loading state.
 */
export default async function CollectionsPage() {
  let collections: AdviceCollection[] = [];
  let loadError: string | null = null;

  try {
    collections = await listCollections(await getShopId());
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load the collections.";
  }

  return <CollectionList initial={collections} loadError={loadError} />;
}

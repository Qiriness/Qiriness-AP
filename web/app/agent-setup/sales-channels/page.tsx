import { SalesChannelList } from "@/components/agent-setup/SalesChannelList";
import { getShopId } from "@/lib/server/knowledge-service";
import { listSalesChannels } from "@/lib/server/sales-channels-service";
import type { SalesChannelsView } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The marketplaces the shop sells on. Loaded server-side like the other setup
 * screens; edits go through the Sales channels API client-side.
 */
export default async function SalesChannelsPage() {
  let initial: SalesChannelsView | null = null;
  let loadError: string | null = null;
  try {
    initial = await listSalesChannels(await getShopId());
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load the sales channels.";
  }
  return <SalesChannelList initial={initial} loadError={loadError} />;
}

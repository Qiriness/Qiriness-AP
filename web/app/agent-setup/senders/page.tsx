import { SenderDirectory } from "@/components/agent-setup/SenderDirectory";
import { getShopId } from "@/lib/server/knowledge-service";
import { listSenders } from "@/lib/server/senders-service";
import type { SenderDirectoryView } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The sender directory: who is our team, our warehouse, a carrier or a retailer.
 * Loaded server-side like the other setup screens; edits go through the Senders
 * API client-side.
 */
export default async function SendersPage() {
  let initial: SenderDirectoryView | null = null;
  let loadError: string | null = null;
  try {
    initial = await listSenders(await getShopId());
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load the sender directory.";
  }
  return <SenderDirectory initial={initial} loadError={loadError} />;
}

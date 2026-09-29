import { ForwardingSettings } from "@/components/agent-setup/ForwardingSettings";
import { getShopId } from "@/lib/server/knowledge-service";
import { getForwardingConfig } from "@/lib/server/forwarding-service";
import { getShop } from "@/lib/server/shop";
import type { ForwardingConfig } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Forwarding — who receives mail the contact team does not own, and what the
 * sender is told. It decides where the agent sends mail, so it sits with the
 * other things that shape the agent.
 *
 * Loads server-side like the other setup screens, so the page renders with real
 * values on first paint. Edits go through the Forwarding API client-side.
 */
export default async function ForwardingPage() {
  let initialConfig: ForwardingConfig | null = null;
  let loadError: string | null = null;

  try {
    const shopId = await getShopId();
    const shop = await getShop();
    initialConfig = await getForwardingConfig(shopId, shop?.shopName ?? null);
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load forwarding settings.";
  }

  return <ForwardingSettings initialConfig={initialConfig} loadError={loadError} />;
}

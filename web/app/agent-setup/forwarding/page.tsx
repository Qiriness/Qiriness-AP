import { ForwardingSettings } from "@/components/agent-setup/ForwardingSettings";
import { getShopId } from "@/lib/server/knowledge-service";
import { listForwarding } from "@/lib/server/forwarding-service";
import type { CategoryForwarding } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The forwarding address book — which colleague receives first-contact mail
 * that is not customer support. It moved here from Settings: it decides where
 * the agent sends mail, so it belongs with the other things that shape the agent.
 *
 * Loads server-side like the other setup screens, so the list renders with real
 * values on first paint. Edits go through the Forwarding API client-side.
 */
export default async function ForwardingPage() {
  let initialForwarding: CategoryForwarding[] = [];
  let loadError: string | null = null;

  try {
    initialForwarding = await listForwarding(await getShopId());
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load forwarding settings.";
  }

  return <ForwardingSettings initialForwarding={initialForwarding} loadError={loadError} />;
}

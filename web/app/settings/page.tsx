import { AppShell } from "@/components/app-shell/AppShell";
import { ForwardingSettings } from "@/components/settings/ForwardingSettings";
import { getShopId } from "@/lib/server/knowledge-service";
import { listForwarding } from "@/lib/server/forwarding-service";
import type { CategoryForwarding } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Settings. Today this is the forwarding address book; it is the first thing
 * that needed a home outside the knowledge workflow.
 *
 * Loads server-side for the same reason the Agent Setup page does: the list
 * renders with real values on first paint instead of flashing empty. Edits go
 * through the Forwarding API client-side.
 */
export default async function SettingsPage() {
  let initialForwarding: CategoryForwarding[] = [];
  let loadError: string | null = null;

  try {
    const shopId = await getShopId();
    initialForwarding = await listForwarding(shopId);
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load forwarding settings.";
  }

  return (
    <AppShell activeHref="/settings">
      <ForwardingSettings initialForwarding={initialForwarding} loadError={loadError} />
    </AppShell>
  );
}

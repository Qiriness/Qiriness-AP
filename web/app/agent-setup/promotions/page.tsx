import { PromotionList } from "@/components/agent-setup/PromotionList";
import { getShopId, listPromotionChoices } from "@/lib/server/promotions-service";
import type { PromotionChoice } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Fetched server-side like the other setup screens, so the page renders with the
 * real codes rather than flashing an empty list somebody might read as "there
 * are none to offer".
 */
export default async function PromotionsPage() {
  let promotions: PromotionChoice[] = [];
  let loadError: string | null = null;

  try {
    promotions = await listPromotionChoices(await getShopId());
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load the promotions.";
  }

  return <PromotionList initial={promotions} loadError={loadError} />;
}

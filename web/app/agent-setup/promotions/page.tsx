import { AutomaticOfferList } from "@/components/agent-setup/AutomaticOfferList";
import { PromotionList } from "@/components/agent-setup/PromotionList";
import { getShopId, listAutomaticOffers, listPromotionChoices } from "@/lib/server/promotions-service";
import type { AutomaticOffer, PromotionChoice } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Fetched server-side like the other setup screens, so the page renders with the
 * real codes rather than flashing an empty list somebody might read as "there
 * are none to offer". Codes first, then automatic offers: two lists with
 * opposite defaults, each failing on its own.
 */
export default async function PromotionsPage() {
  let promotions: PromotionChoice[] = [];
  let offers: AutomaticOffer[] = [];
  let loadError: string | null = null;
  let offersError: string | null = null;

  const shopId = await getShopId().catch((error: unknown) => {
    loadError = error instanceof Error ? error.message : "Failed to load the promotions.";
    return null;
  });

  if (shopId) {
    try {
      promotions = await listPromotionChoices(shopId);
    } catch (error) {
      loadError = error instanceof Error ? error.message : "Failed to load the promotions.";
    }
    try {
      offers = await listAutomaticOffers(shopId);
    } catch (error) {
      offersError = error instanceof Error ? error.message : "Failed to load the automatic offers.";
    }
  }

  return (
    <>
      <PromotionList initial={promotions} loadError={loadError} />
      <AutomaticOfferList initial={offers} loadError={offersError ?? (shopId ? null : loadError)} />
    </>
  );
}

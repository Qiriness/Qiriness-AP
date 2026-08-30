import { ParameterList } from "@/components/agent-setup/ParameterList";
import { getShopId, listParameters } from "@/lib/server/parameters-service";
import type { SupportParameter } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The parameters, fetched server-side like the other two screens so the page
 * renders with real values rather than flashing empty.
 *
 * The list is driven by the CATALOGUE in `scripts/lib/parameters.mjs`, not by the
 * rows — a parameter nobody has set yet is exactly the one somebody needs to see.
 */
export default async function ParametersPage() {
  let parameters: SupportParameter[] = [];
  let loadError: string | null = null;

  try {
    parameters = await listParameters(await getShopId());
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load the parameters.";
  }

  return <ParameterList initial={parameters} loadError={loadError} />;
}

import { PolicyLibrary } from "@/components/agent-setup/PolicyLibrary";
import { getShopId } from "@/lib/server/parameters-service";
import { listCompanyPolicies, listPolicyTargets } from "@/lib/server/company-policy-service";
import { PARAMETER_KEYS } from "../../../../scripts/lib/parameters.mjs";
import type { CompanyPolicy, CompanyPolicyTargets } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The company policies, fetched server-side like the rulebook so the screen
 * renders with the real library rather than flashing empty. Mutations go
 * through /api/company-policies.
 */
export default async function PoliciesPage() {
  let policies: CompanyPolicy[] = [];
  let targets: CompanyPolicyTargets = { situations: [], rules: [] };
  let loadError: string | null = null;

  try {
    const shopId = await getShopId();
    [policies, targets] = await Promise.all([listCompanyPolicies(shopId), listPolicyTargets(shopId)]);
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load the policies.";
  }

  return <PolicyLibrary initial={policies} targets={targets} parameterKeys={[...PARAMETER_KEYS] as string[]} loadError={loadError} />;
}

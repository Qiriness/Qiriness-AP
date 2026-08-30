import { RuleBook } from "@/components/agent-setup/RuleBook";
import {
  getShopId,
  listRules,
  listSituations,
  policyVocabulary,
} from "@/lib/server/policy-service";
import type { PolicyRule, PolicySituation, PolicyVocabulary } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The rulebook, fetched server-side for the same reason the article list is —
 * so the screen renders with the real rules on first paint rather than flashing
 * empty. Mutations go back through /api/policy/*.
 *
 * A SEPARATE ROUTE FROM /agent-setup, not a tab inside it. `AgentSetup` is
 * already a single client orchestrator holding the article library, the editor,
 * the brand voice and the test chat; the rulebook shares no state with any of
 * them, and folding it in would grow the one component on this page that is
 * hardest to reason about.
 */
export default async function RuleBookPage() {
  let rules: PolicyRule[] = [];
  let situations: PolicySituation[] = [];
  let vocabulary: PolicyVocabulary = { needs: [], routes: [], asks: [], parameters: [] };
  let loadError: string | null = null;

  try {
    const shopId = await getShopId();
    [rules, situations, vocabulary] = await Promise.all([
      listRules(shopId),
      listSituations(shopId),
      policyVocabulary(shopId),
    ]);
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load the rulebook.";
  }

  return (
    <RuleBook
      initialRules={rules}
      situations={situations}
      vocabulary={vocabulary}
      loadError={loadError}
    />
  );
}

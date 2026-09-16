import type { PolicyRule } from "./types";

/**
 * English names for the shared (general) rules, for display only.
 *
 * THE KEYS STAY FRENCH AND STAY THE IDENTITY. `answer_key` is unique per set,
 * recorded on every investigation that selected it, and read back by reports —
 * renaming it would orphan every stored run. So the screen shows these names
 * and keeps the key one hover away. A shared rule added later with no entry
 * here simply shows its key.
 */
const SHARED_RULE_LABELS: Record<string, string> = {
  reaction_signalee: "Reaction reported",
  commande_annulee: "Order cancelled",
  expediee_sans_scan: "Dispatched, no scan",
  non_expediee: "Not dispatched yet",
  client_professionnel: "Trade customer",
  produit_ambigu: "Product unclear",
  produit_non_documente: "Product not documented",
};

/** What to call a rule on screen: the English name of a shared rule, otherwise its key. */
export function ruleLabel(rule: Pick<PolicyRule, "answerKey" | "situationKey">): string {
  return (!rule.situationKey && SHARED_RULE_LABELS[rule.answerKey]) || rule.answerKey;
}

/**
 * The live general rules that answer one branch when no situation rule does.
 *
 * DERIVED, NEVER CHOSEN. `selectAnswer` takes a shared rule whenever its
 * conditions hold and no rule keyed to the situation matched, so this mirrors
 * that rather than letting the screen claim a coverage the agent would not
 * apply: a rule counts only if it is approved, names no situation, is not the
 * fallback, and every condition it has is this need with this finding — or it
 * has none, in which case it matches anything.
 */
export function generalRulesCovering(rules: PolicyRule[], need: string, finding: string): PolicyRule[] {
  return rules.filter(
    (rule) =>
      !rule.situationKey &&
      !rule.isFallback &&
      rule.approvalStatus === "approved" &&
      Object.entries(rule.conditions).every(([key, values]) => key === need && values.includes(finding)),
  );
}

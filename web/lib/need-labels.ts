/**
 * The evidence needs (`agent/src/investigation/evidence-rules.mjs NEED_KEYS`)
 * in the dashboard's English. The agent keeps its French labels for its
 * prompts; this is what an operator reads.
 *
 * One map for every screen that names a need: the Insights blockers and the
 * checks owed on a case. Anything not named here is title-cased from its slug.
 */
const NEED_LABELS: Record<string, string> = {
  order_identity: "Which order is this",
  order_state: "Where the order stands",
  delivery_state: "Where the parcel is",
  delivery_delay_state: "Whether delivery is running late",
  dispatch_state: "Whether the order has left the warehouse",
  refund_state: "Where the refund stands",
  payment_state: "Whether the payment went through",
  promotion_identity: "Which promotion is this",
  promotion_validity: "Whether the code is live",
  promotion_eligibility: "Whether this order qualifies",
  promotion_outcome: "Why the promotion did or did not apply",
  product_identity: "Which product is this",
  product_property: "A fact about the product",
  product_availability: "Whether it is in stock",
  product_recommendation: "What to recommend",
  customer_identity: "Who is writing",
  customer_account_state: "The state of their account",
  return_eligibility: "Whether a return is still possible",
  policy_attached: "Whether the situation's policy was attached",
  checkout_state: "What was in the abandoned basket",
  reaction_product: "Which product caused the reaction",
  photo_evidence: "The photo",
  other_fact: "Something else the reply needed",
};

export function needLabel(need: string): string {
  if (NEED_LABELS[need]) return NEED_LABELS[need];
  const words = need.split("_").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

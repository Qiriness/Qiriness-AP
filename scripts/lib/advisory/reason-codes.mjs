/**
 * Every reason the engine can give, in one place: explanations to the model,
 * labels in traces and events, assertions in tests. A code the explanation
 * layer does not know is a bug, not a new phrasing.
 */

/** Hard eligibility: why a product could not be recommended at all. */
export const EXCLUSION = {
  OUT_OF_STOCK: 'out_of_stock',
  WRONG_AREA: 'wrong_area',
  WRONG_TARGET: 'wrong_target',
  BUNDLE_NOT_REQUESTED: 'bundle_not_requested',
  EXCLUDED_BY_CUSTOMER: 'excluded_by_customer',
  UNSUITABLE: 'unsuitable',
  /** The brand's knowledge says « Ne pas conseiller ». */
  NOT_ADVISED: 'not_advised'
};

/** Why a product was chosen for a step (`code` or `code:detail`). */
export const FIT = {
  PRIMARY_CONCERN: 'primary_concern',
  SECONDARY_CONCERN: 'secondary_concern',
  SKIN_TYPE_MATCH: 'skin_type_match',
  SKIN_TYPE_MISMATCH: 'skin_type_mismatch',
  TEXTURE_MATCH: 'texture_match',
  TEXTURE_MISMATCH: 'texture_mismatch',
  SENSITIVE_SKIN_MATCH: 'sensitive_skin_match',
  NOT_FOR_SENSITIVE: 'not_for_sensitive',
  AGE_TIEBREAK: 'age_tiebreak',
  PREFERRED_FAMILY: 'preferred_family',
  PREFERRED_UNAVAILABLE: 'preferred_unavailable',
  SLOT_NAME_MATCH: 'slot_name_match',
  MERCHANDISED: 'merchandised',
  /** From a range the customer uses (purchase history): a nudge, never a reason alone. */
  CUSTOMER_RANGE: 'customer_range',
  /** The product the customer came in with (or is running low on): the routine is built around it. */
  CUSTOMER_INTEREST: 'customer_interest',
  /** They have a product of this type, but their concern needs a specific one for this step (owner's rule). */
  CONCERN_NEEDS_SPECIFIC_PRODUCT: 'concern_needs_specific_product',
  /** A required step had no product: this optional step takes its place (owner, 2026-10-16). */
  REPLACES_MISSING_STEP: 'replaces_missing_step',
  /** The range their age gives (`age_range:45_plus`): Exception, Temps Sublime, Active Énergie (owner, 2026-10-16). */
  AGE_RANGE: 'age_range',
  /** Made for this moment of the routine (`made_for_time:night`): a night cream (owner, 2026-10-16). */
  MADE_FOR_TIME: 'made_for_time',
  /** The step's own product (Routines tab « Produit »): always this one (owner, 2026-10-17: the eye routine). */
  STEP_PRODUCT: 'step_product',
  /** No product met the step's criteria: its « Produit » instead (the standard eye cream). */
  STEP_FALLBACK: 'step_fallback',
  /** The type they asked for has nothing in stock for their concern: another type that treats it (owner, 2026-10-19). */
  ASKED_TYPE_UNAVAILABLE: 'asked_type_unavailable'
};

/** Why a step of the playbook was not filled. */
export const SKIPPED = {
  ALREADY_IN_ROUTINE: 'already_in_routine',
  /** A product the customer said they still use fills this step (`product_id`). */
  ALREADY_OWNED: 'already_owned',
  /** Left out to keep the routine within the customer's budget. */
  OVER_BUDGET: 'over_budget',
  NO_ELIGIBLE_PRODUCT: 'no_eligible_product',
  /** Day and night: this night step's product is already in the day routine (`product_id`), used morning and evening. */
  ALSO_IN_DAY_ROUTINE: 'also_in_day_routine'
};

/** Why a product to build the routine around was not placed (`pinned` in the advice). */
export const PINNED = {
  PLACED: 'placed',
  UNAVAILABLE: 'pinned_unavailable',
  UNSUITABLE: 'pinned_unsuitable',
  NO_STEP: 'pinned_no_step'
};

/** Why the engine has no recommendation yet. */
export const STATUS = {
  RECOMMENDED: 'recommended',
  NEEDS_INFO: 'needs_info',
  NO_MATCH: 'no_match'
};

export const NO_MATCH = {
  NO_PLAYBOOK: 'no_playbook_for_concern',
  NO_PLAYBOOK_FOR_AREA: 'no_playbook_for_area',
  NO_PRODUCT: 'no_eligible_product',
  /** The brand's routines have no foundation for this area (a body request on a face-only bench). */
  AREA_NOT_COVERED: 'area_not_covered'
};

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
  UNSUITABLE: 'unsuitable'
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
  MERCHANDISED: 'merchandised'
};

/** Why a step of the playbook was not filled. */
export const SKIPPED = {
  ALREADY_IN_ROUTINE: 'already_in_routine',
  NO_ELIGIBLE_PRODUCT: 'no_eligible_product'
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
  NO_PRODUCT: 'no_eligible_product'
};

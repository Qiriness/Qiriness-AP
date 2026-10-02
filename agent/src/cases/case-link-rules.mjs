// Does this new thread continue one of the customer's existing cases?
//
// PURE AND DETERMINISTIC. Every decision a database field, an identifier, a
// timestamp or an exact match can make is made here, and the Case Linker model
// (case-linker-model.mjs) is asked only when this returns `ambiguous`: plausible
// candidates exist and nothing here can safely choose between them.
//
// WHAT A LINK COSTS NOW, and why it is safer than it was. Before cases, a link
// between two threads SILENCED one of them (duplicate_of_ticket_id), which is
// why « same sender + same order number » was deliberately not a rule
// (DECISIONS § Duplicate link): a delivery ticket and a later refund ticket about
// one order would have cost the second its answer. A case link silences
// nobody: the case's reply target is the newest unanswered customer message, on
// whichever thread, and the investigation reads every thread. What a wrong link
// costs now is a reply informed by an unrelated thread. So the same order is a
// rule here, guarded by the issue family: a delivery that becomes a refund is
// one case, a product question on the same order is not.
//
// WHAT NEVER LINKS ON ITS OWN: the same sender, similar wording, a similar
// embedding. Those may bring a case into the candidates; they never decide.

/** The rules that link without a model, in the order they are tried. */
export const DETERMINISTIC_METHODS = Object.freeze(['tracking', 'order_family', 'unique_match']);

/**
 * Whether a case about `from` may continue as `to`. A family is always
 * compatible with itself; any other move must be configured
 * (`issue_family_transitions`). An unknown family is compatible with nothing.
 */
export function compatibleFamilies(from, to, transitions = []) {
  if (!from || !to) return false;
  if (from === to) return true;
  return transitions.some(([a, b]) => a === from && b === to);
}

/** The family of a subject or a situation, from the shop's configuration. */
export function familyOf({ subject = null, situation = null } = {}, families = {}) {
  if (situation && families.situations?.[situation]) return families.situations[situation];
  if (subject && families.subjects?.[subject]) return families.subjects[subject];
  return null;
}

/**
 * The case key: `customer | order | family`, when all three are known.
 * A strong signal, never the only one (a message may name no order).
 */
export function caseKey({ customerKey, orderNumber, family }) {
  if (!customerKey || !orderNumber || !family) return null;
  return `${customerKey}|${String(orderNumber).replace(/^#/, '')}|${family}`;
}

const normOrder = (value) => (value === null || value === undefined || value === '' ? null : String(value).replace(/^#/, '').trim());

/**
 * @param thread      { excluded, hasPriorCases, orderNumber, trackingNumbers, family }
 *   `excluded`: a sender listed in sender_directory, or a thread one of us
 *   opened. `hasPriorCases`: whether the customer has ANY other case in the
 *   window, before plausibility filtering.
 * @param candidates  [{ caseId, orderNumbers, trackingNumbers, family, reasons }]
 *   already narrowed to the customer's plausible cases (at most a handful).
 * @param transitions [[from, to], ...] from issue_family_transitions
 * @returns
 *   { decision: 'link', caseId, method }
 *   { decision: 'new_case', method }
 *   { decision: 'ambiguous', candidates }
 */
export function decideLink({ thread = {}, candidates = [], transitions = [] } = {}) {
  if (thread.excluded) return { decision: 'new_case', method: 'excluded_sender' };
  if (!thread.hasPriorCases) return { decision: 'new_case', method: 'first_contact' };
  if (candidates.length === 0) return { decision: 'new_case', method: 'no_candidates' };

  const order = normOrder(thread.orderNumber);
  const tracking = new Set((thread.trackingNumbers ?? []).filter(Boolean));
  const ordersOf = (candidate) => (candidate.orderNumbers ?? []).map(normOrder).filter(Boolean);
  const sharesTracking = (candidate) => (candidate.trackingNumbers ?? []).some((number) => tracking.has(number));
  const sharesOrder = (candidate) => Boolean(order) && ordersOf(candidate).includes(order);
  // A candidate about a DIFFERENT order than the one this thread names is
  // contradictory evidence, whatever else it shares.
  const contradictsOrder = (candidate) => Boolean(order) && ordersOf(candidate).length > 0 && !ordersOf(candidate).includes(order);
  const compatible = (candidate) => compatibleFamilies(candidate.family, thread.family, transitions);
  const familyUnknown = (candidate) => !candidate.family || !thread.family;

  // 1. SAME SHIPMENT. A tracking number is one parcel; the case about that
  // parcel is the case, unless the orders say otherwise.
  if (tracking.size > 0) {
    const byTracking = candidates.filter(sharesTracking);
    if (byTracking.length === 1 && !contradictsOrder(byTracking[0])) {
      return { decision: 'link', caseId: byTracking[0].caseId, method: 'tracking' };
    }
  }

  // 2. SAME ORDER, COMPATIBLE PROBLEM. delivery_late -> delivery_not_received ->
  // parcel_lost -> refund is one case; a product question on that order is not.
  if (order) {
    const byOrder = candidates.filter(sharesOrder);
    const compatibleOnes = byOrder.filter(compatible);
    if (compatibleOnes.length === 1) {
      return { decision: 'link', caseId: compatibleOnes[0].caseId, method: 'order_family' };
    }
  }

  // 3. THE ONLY CASE ABOUT THIS ORDER OR PARCEL, when the family cannot be read
  // on one side (an uncategorised thread, a subject with no family). Never
  // when the families are known and incompatible: that is a second problem.
  const matching = candidates.filter((candidate) => (sharesOrder(candidate) || sharesTracking(candidate)) && !contradictsOrder(candidate));
  if (matching.length === 1 && (compatible(matching[0]) || familyUnknown(matching[0]))) {
    return { decision: 'link', caseId: matching[0].caseId, method: 'unique_match' };
  }

  return { decision: 'ambiguous', candidates };
}

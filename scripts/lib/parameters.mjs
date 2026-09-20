// The numbers the support desk runs on, and the only place that parses them.
//
// A PARAMETER IS NOT A KNOWLEDGE ARTICLE, and the split is the same one this
// codebase draws everywhere else: prose for people, closed values for machines.
// An article says « vous disposez de 30 jours » to a customer; a rule has to
// compare 30 against a delivery date, and no deriver should be reading a number
// out of a paragraph to do it.
//
// WHY IT EXISTS AT ALL, measured on this shop's own library: two approved
// articles gave two different returns windows — « une politique de retour de 30
// jours » and « un droit de rétractation … de 14 jours » — and which one a
// customer was told depended on which article retrieval surfaced. One number in
// two paragraphs will always do that eventually.
//
// EVERY READ CAN RETURN NULL, and callers must handle it. A parameter starts
// undecided, because the numbers are the merchant's and seeding a guess would
// put a third answer into circulation wearing the authority of a setting.

/**
 * The parameters this codebase knows how to use.
 *
 * DECLARED HERE, NOT DISCOVERED FROM THE TABLE. A key nothing reads is a setting
 * an operator can spend time on for no effect, and a key code reads that the
 * table has never heard of is a silent null. Naming them in one place lets the
 * dashboard offer exactly the ones that do something, and lets a migration test
 * assert the two agree.
 *
 * `usedBy` is prose for the editing screen: somebody deciding a number is owed
 * an answer to "what happens if I change this".
 */
export const PARAMETERS = {
  returns_window_days: {
    kind: 'days',
    label: 'How long after delivery can a customer return an order?',
    description:
      'Counted from the delivery date. Decides whether a return is still possible, ' +
      'and is the number a reply quotes. Your two approved articles currently ' +
      'disagree — "Refund policy" says 30 days, "Livraisons et retours" says 14.',
    usedBy: 'the return_eligibility state, and any rule that branches on it'
  },
  withdrawal_days: {
    kind: 'days',
    label: 'EU right of withdrawal, in days',
    description:
      'The statutory cooling-off period, which is separate from your own returns ' +
      'policy and may be shorter. Stated in "Refund policy" as 14 days.',
    usedBy: 'replies that must distinguish the legal right from the shop policy'
  },
  refund_processing_days: {
    kind: 'days',
    label: 'Once a return is approved, how long until the refund lands?',
    description:
      'Working days. Quoted to a customer asking when their money comes back, so a ' +
      'reply never has to invent one.',
    usedBy: 'refund replies'
  },
  dispatch_days: {
    kind: 'days',
    label: 'How long between an order and its dispatch?',
    description:
      'Working days. The single most-asked question in the corpus (O-09, 22 messages) ' +
      'and the one an agent currently cannot answer without guessing.',
    usedBy: 'the non_expediee rule, which today says only that it has not shipped'
  },
  france_delivery_days: {
    kind: 'days',
    label: 'Once dispatched, how long does delivery take in France?',
    description:
      'Working days, counted from dispatch to the parcel arriving — the usual case, ' +
      'not a promise for one parcel. Asked for 2026-09-20. It is the only thing we ' +
      'can honestly say about a dispatched parcel: no carrier feeds scan events into ' +
      'Shopify for this store, so where a parcel actually is remains unknown.',
    usedBy:
      'the delivery_delay_state state for a parcel shipped to France, and any rule ' +
      'that branches on it — today `dispatched_no_scan_delivery_late`'
  },
  // THE SAME QUESTION WITH A DIFFERENT ANSWER, and it has to be a second number
  // rather than a margin on the first: a parcel that is late to Paris is still
  // on time to Milan, and one window would make the rule wrong in one direction
  // for 88% of orders or in the other for 12%.
  //
  // MEASURED OVER THE LAST 1 000 ORDERS (2026-09-20): 881 France, 119 abroad —
  // Belgium 58, Italy 24, the Netherlands 14, then the United States, Switzerland,
  // Monaco, Spain, Hong Kong, Portugal and Luxembourg. Not an edge case, and not
  // a single country either, which is why it is one number for "not France"
  // rather than a table: no destination outside France carries enough tickets to
  // measure its own window.
  abroad_delivery_days: {
    kind: 'days',
    label: 'Once dispatched, how long does delivery take outside France?',
    description:
      'Working days, counted from dispatch, for every destination that is not France. ' +
      'Asked for 2026-09-20. Same honesty limit as the France number: it is the usual ' +
      'case rather than a promise about one parcel, because no carrier feeds scan ' +
      'events into Shopify for this store.',
    usedBy:
      'the delivery_delay_state state for a parcel shipped outside France, and any ' +
      'rule that branches on it — today `dispatched_no_scan_delivery_late`'
  },
  free_shipping_threshold: {
    kind: 'amount',
    label: 'Order total for free standard delivery',
    description: 'In the shop currency. "Livraisons et retours" states 70 €.',
    usedBy: 'delivery replies'
  },
  consumer_order_ceiling: {
    kind: 'amount',
    label: 'Above what order total is a sender not a consumer?',
    description:
      'In the shop currency. A message naming a sum above this is treated as coming ' +
      'from a trade customer rather than a shopper, because no consumer order comes ' +
      'anywhere near it: the largest ever placed is 488,60 € and the 99th percentile ' +
      'is 248,57 €. Measured at 500 € this catches all four trade tickets that were ' +
      'filed as payment or promotions, and no consumer ticket at all. Deliberately not ' +
      '"the largest order ever", which ratchets: one trade order syncing into Shopify ' +
      'would raise the ceiling above itself and switch the guard off.',
    usedBy: 'the buyer_type state, and the payments rules that route a trade sender to a person'
  },
  returns_address: {
    kind: 'text',
    label: 'Where does a customer send a return?',
    description:
      'The address a return goes to. Held here rather than repeated in every rule ' +
      'that needs it, so moving warehouse is one edit.',
    usedBy: 'every returns rule'
  }
};

export const PARAMETER_KEYS = Object.keys(PARAMETERS);

/** The kinds a value can be, mirrored by the check constraint in 09. */
export const PARAMETER_KINDS = ['days', 'amount', 'text'];

/**
 * Turns rows into a lookup the readers below use.
 *
 * Unknown keys are DROPPED rather than carried: a row for a parameter nothing
 * reads cannot be acted on, and keeping it would let a caller ask for one and
 * get an answer this codebase has no meaning for.
 */
export function toParameterMap(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const key = row?.parameter_key;
    if (PARAMETERS[key]) {
      map.set(key, row?.value ?? null);
    }
  }
  return map;
}

/**
 * A whole number of days, or null when nobody has decided it.
 *
 * NULL IS NOT ZERO, and the difference matters more here than usual: zero days
 * would make every return out of window, which is a policy nobody wrote.
 */
export function days(map, key) {
  if (PARAMETERS[key]?.kind !== 'days') {
    return null;
  }
  const raw = map?.get?.(key) ?? null;
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return null;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** A decimal amount, or null. Same rule as `days`. */
export function amount(map, key) {
  if (PARAMETERS[key]?.kind !== 'amount') {
    return null;
  }
  const raw = map?.get?.(key) ?? null;
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Free text, trimmed, or null when empty. */
export function text(map, key) {
  if (PARAMETERS[key]?.kind !== 'text') {
    return null;
  }
  const raw = String(map?.get?.(key) ?? '').trim();
  return raw.length > 0 ? raw : null;
}

// --- quoting a parameter in prose --------------------------------------------
//
// THE SECOND WAY A PARAMETER REACHES A REPLY, and it is the opposite of the
// first. A state like `return_eligibility` uses the number to make a DECISION and
// the reply never sees it. A skeleton that wants to SAY the number — « vous
// disposez de 30 jours » — needs it as text, and typing 30 into the skeleton
// would be the fourth copy of a number this whole table exists to hold once.
//
// So a skeleton writes `{returns_window_days}` and it is substituted when the
// drafting prompt is composed.

const PLACEHOLDER = /\{([a-z][a-z0-9_]*)\}/g;

/** Every parameter a piece of text quotes, in the order first seen. */
export function placeholdersIn(value) {
  const found = [];
  for (const match of String(value ?? '').matchAll(PLACEHOLDER)) {
    if (!found.includes(match[1])) {
      found.push(match[1]);
    }
  }
  return found;
}

/**
 * Substitutes every `{parameter}` a text quotes.
 *
 * RETURNS THE PROBLEMS RATHER THAN THROWING, because the caller decides what an
 * unresolved placeholder means. Two kinds, and they are different failures:
 *
 *   `unknown`  — the skeleton names a parameter this codebase has never heard
 *                of. An authoring mistake, and the editor refuses it on save.
 *   `unset`    — a real parameter nobody has decided yet. Not a mistake: it is
 *                the state every parameter starts in, and the honest answer is
 *                that this rule cannot be worded until somebody chooses.
 *
 * A TEXT WITH AN UNRESOLVED PLACEHOLDER IS RETURNED UNCHANGED, placeholder and
 * all — never half-substituted and never silently emptied. Half of a sentence
 * about a returns window is worse than an obviously broken one, and the caller
 * that has to decide is holding both the text and the reason.
 */
export function fillParameters(value, map) {
  const source = String(value ?? '');
  const unknown = [];
  const unset = [];

  const filled = source.replace(PLACEHOLDER, (whole, key) => {
    const definition = PARAMETERS[key];
    if (!definition) {
      unknown.push(key);
      return whole;
    }
    const raw = map?.get?.(key) ?? null;
    const resolved = raw === null || raw === undefined || String(raw).trim() === '' ? null : String(raw).trim();
    if (resolved === null) {
      unset.push(key);
      return whole;
    }
    return resolved;
  });

  return { text: filled, unknown, unset, resolved: unknown.length === 0 && unset.length === 0 };
}

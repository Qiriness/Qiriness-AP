export function dedupeRows(rows, keyFn) {
  const seen = new Set();
  const deduped = [];

  for (const row of rows) {
    const key = keyFn(row);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(row);
  }

  return deduped;
}

export function stripUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  );
}

/**
 * The first few of a list, named, plus a count of the rest.
 *
 * FOR PROSE A MODEL OR A CUSTOMER READS, where the useful answer is "these, and
 * there are more" rather than an exhaustive enumeration. It exists because the
 * exhaustive version caused a real outage: `listActivePromotions` named all 3619
 * active redeem codes in one tool result — 259,874 characters against a 30,000
 * token-per-minute ceiling — and the investigation failed outright on a
 * 284-character email.
 *
 * Naming everything is also worse as an ANSWER. "Ce code s'applique à 94
 * produits" tells a customer what they need; ninety-four titles does not.
 */
export function namedSample(items, { max = 5, render = String, separator = ', ' } = {}) {
  const all = (Array.isArray(items) ? items : []).filter(Boolean);
  const shown = all.slice(0, max).map(render);
  const rest = all.length - shown.length;
  if (rest <= 0) {
    return shown.join(separator);
  }
  return `${shown.join(separator)} et ${rest} autre${rest > 1 ? 's' : ''}`;
}

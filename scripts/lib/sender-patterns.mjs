// Matching an inbound sender against a list of email-or-domain patterns.
//
// Extracted because two tables now hold exactly this shape — `email_blocklist`
// (should this mail be dropped?) and `sender_directory` (who is this?) — and the
// matching between them has to stay identical. It is small but not obvious:
// normalisation, `lastIndexOf('@')` rather than a split, and a suffix rule so a
// pattern for `linkedin.com` also catches `e.linkedin.com`. Two copies of that
// would eventually disagree, and the disagreement would be silent.
//
// Pure: no I/O. The caller supplies the rows.

/** Lowercased, trimmed address. Null when there is nothing usable. */
export function normalizeEmail(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}

/** Lowercased, trimmed domain with any leading `@` removed. */
export function normalizeDomain(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().toLowerCase().replace(/^@/, '');
  return trimmed || null;
}

/**
 * The domain half of an address.
 *
 * `lastIndexOf`, not `split('@')[1]`: a display-name-shaped value that slipped
 * through with two `@` signs must resolve to the real domain, not the first one.
 */
export function domainOf(email) {
  const at = String(email || '').lastIndexOf('@');
  return at >= 0 ? String(email).slice(at + 1) || null : null;
}

/**
 * Indexes rows of `{ pattern_type, pattern, ... }` for lookup by sender address.
 *
 * Rows keep their own shape — callers read whatever columns they added (a
 * blocklist rule's id, a directory entry's label). This only decides WHICH row a
 * sender matches.
 *
 * PRECEDENCE IS EXACT ADDRESS, THEN DOMAIN, THEN PARENT DOMAIN, and that order is
 * the point of the structure: an exact entry exists precisely to say something
 * different from the domain it belongs to. One address at a partner agency being
 * blocked cannot be overridden by the agency's own domain rule.
 */
export function buildPatternIndex(rows = []) {
  const emails = new Map();
  const domains = new Map();

  for (const row of rows) {
    if (row?.pattern_type === 'email') {
      const value = normalizeEmail(row.pattern);
      if (value) emails.set(value, row);
    } else if (row?.pattern_type === 'domain') {
      const value = normalizeDomain(row.pattern);
      if (value) domains.set(value, row);
    }
  }

  return {
    size: emails.size + domains.size,

    /** @returns {{ row, matched: 'email'|'domain' } | null} */
    match(fromEmail) {
      const email = normalizeEmail(fromEmail);
      if (!email) {
        return null;
      }
      if (emails.has(email)) {
        return { row: emails.get(email), matched: 'email' };
      }
      const domain = domainOf(email);
      if (!domain) {
        return null;
      }
      if (domains.has(domain)) {
        return { row: domains.get(domain), matched: 'domain' };
      }
      // Subdomains belong to their parent: mail from `mail.deret.fr` is still
      // Deret when `deret.fr` is listed.
      for (const [candidate, row] of domains) {
        if (domain.endsWith('.' + candidate)) {
          return { row, matched: 'domain' };
        }
      }
      return null;
    }
  };
}

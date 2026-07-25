// Deterministic, no-LLM spam classifier: matches the inbound sender against the
// email_blocklist rules (exact address or sender domain). Pure logic, so it is
// unit-tested without a database; blocklist-store loads the rules and records hits.

export function buildSpamGate(rules = []) {
  const emails = new Map(); // normalized email -> rule
  const domains = new Map(); // normalized domain -> rule

  for (const rule of rules) {
    if (rule.pattern_type === 'email') {
      const value = normalizeEmail(rule.pattern);
      if (value) emails.set(value, rule);
    } else if (rule.pattern_type === 'domain') {
      const value = normalizeDomain(rule.pattern);
      if (value) domains.set(value, rule);
    }
  }

  return {
    // item is a mapped Graph message from graph-message-mapper.
    check(item) {
      if (!item || item.removed) {
        return { spam: false };
      }
      const email = normalizeEmail(item.message?.from_email);
      if (!email) {
        return { spam: false };
      }
      if (emails.has(email)) {
        return blocked(emails.get(email), 'email');
      }
      const domain = domainOf(email);
      if (domain) {
        if (domains.has(domain)) {
          return blocked(domains.get(domain), 'domain');
        }
        // Suffix match: a rule for "linkedin.com" also blocks "e.linkedin.com"
        // and other subdomains those platforms actually send from.
        for (const [ruleDomain, rule] of domains) {
          if (domain.endsWith('.' + ruleDomain)) {
            return blocked(rule, 'domain');
          }
        }
      }
      return { spam: false };
    }
  };
}

// A gate that lets everything through — the default when no blocklist is wired.
export const allowAllGate = { check: () => ({ spam: false }) };

// The verdict carries the matched pattern (not just the rule id) so the spam_audit
// reason can name what actually blocked the email without a second lookup.
function blocked(rule, matched) {
  return {
    spam: true,
    ruleId: rule.id,
    matched,
    pattern: rule.pattern ?? null,
    reason: `blocklist ${matched} rule${rule.pattern ? `: ${rule.pattern}` : ''}`
  };
}

export function normalizeEmail(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}

export function normalizeDomain(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().toLowerCase().replace(/^@/, '');
  return trimmed || null;
}

function domainOf(email) {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1) : null;
}

import { buildPatternIndex } from '../../../scripts/lib/sender-patterns.mjs';

// Deterministic, no-LLM spam classifier: matches the inbound sender against the
// email_blocklist rules (exact address or sender domain). Pure logic, so it is
// unit-tested without a database; blocklist-store loads the rules and records hits.
//
// The matching itself lives in scripts/lib/sender-patterns.mjs, shared with
// sender_directory: both tables answer a question about the same inbound sender
// using the same email-or-domain patterns, and two copies of that rule (exact
// before domain, subdomains belong to their parent) would drift apart quietly.

export function buildSpamGate(rules = []) {
  const index = buildPatternIndex(rules);

  return {
    // item is a mapped Graph message from graph-message-mapper.
    check(item) {
      if (!item || item.removed) {
        return { spam: false };
      }
      const hit = index.match(item.message?.from_email);
      return hit ? blocked(hit.row, hit.matched) : { spam: false };
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

// Re-exported so blocklist-store and add-blocklist keep their existing import
// site while the implementation lives with the matcher that consumes it.
export { normalizeEmail, normalizeDomain } from '../../../scripts/lib/sender-patterns.mjs';

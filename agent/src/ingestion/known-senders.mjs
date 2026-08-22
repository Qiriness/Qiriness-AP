// A sender we have written down is never spam.
//
// THE DIRECTORY IS AN ASSERTION, NOT A HINT. Somebody sat down and recorded that
// this domain is our 3PL, our web agency, a retailer we sell through. Letting a
// blocklist pattern or a language model overrule that turns a deliberate act of
// configuration into a suggestion — and the failure is silent, because dropped
// mail never becomes a ticket and only ever appears in `spam_audit`.
//
// MEASURED ON THE CORPUS (2026-08-19). Four blocked emails came from addresses
// already in the directory:
//
//   EARGENTO@nocibe.fr        retailer    dropped by the LLM as an "automatic notification"
//   dnouali@lap-groupe.com    internal    dropped by the LLM, twice
//   patrick@dopweb.com        contractor  dropped by an explicit blocklist rule
//
// The Nocibé one is a routing-address change from a retailer we sell through.
// The lap-groupe ones are a colleague forwarding a customer's message in.
//
// IT WRAPS BOTH GATES BECAUSE BOTH GATES GOT IT WRONG — a pattern rule and a
// model, failing the same way for different reasons. Wrapping is deliberate:
// neither gate learns about the directory, so neither can be half-taught.
//
// THE LLM CALL IS SKIPPED, NOT OVERRULED. Deciding after the model has answered
// would pay for a judgement we were always going to discard.
//
// WHAT THIS DOES NOT DO: it never *blocks* anything. A sender absent from the
// directory is left to the gates exactly as before, so the only direction this
// can move a decision is towards keeping mail.

/**
 * @param senderDirectory  from `buildSenderDirectory`; `lookup()` returns null
 *                         for an unlisted address, which is the ordinary case.
 * @param gate             the blocklist gate (`buildSpamGate`)
 * @param triage           the LLM classifier, or undefined when no key is set
 * @returns the same pair, with known senders exempted
 */
export function exemptKnownSenders({ senderDirectory, gate, triage, logger } = {}) {
  const known = (item) => {
    const fromEmail = item?.message?.from_email;
    if (!fromEmail) {
      return null;
    }
    return senderDirectory?.lookup?.(fromEmail) ?? null;
  };

  const note = (stage, item, hit) =>
    logger?.info?.('ingest.spam_exempt', {
      stage,
      label: hit.label,
      matched: hit.pattern ?? hit.matched ?? null,
      subject: item?.message?.subject ?? null
    });

  return {
    gate: gate
      ? {
          ...gate,
          check(item) {
            const hit = known(item);
            if (hit) {
              note('blocklist', item, hit);
              return { spam: false, exemptedBy: hit.label };
            }
            return gate.check(item);
          }
        }
      : gate,

    triage: triage
      ? async (item) => {
          const hit = known(item);
          if (hit) {
            note('llm', item, hit);
            // Shaped like a real verdict so the audit row reads the same as any
            // other kept mail, rather than needing a special case downstream.
            return { spam: false, reason: `known sender (${hit.label})`, exemptedBy: hit.label };
          }
          return triage(item);
        }
      : triage
  };
}

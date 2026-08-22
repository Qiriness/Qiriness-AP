import { hashIdentifier } from '../../../scripts/lib/compliance-audit.mjs';

import { OWN_SIDE_LABELS } from './sender-directory.mjs';

// Puts the right person's name on tickets that ended up wearing a colleague's.
//
// WHY ANY ARE WRONG. `tickets.requester_*` is written once, from whichever
// message created the ticket, and never revised — deliberately, because a
// ticket's requester flipping about would be worse than one that is occasionally
// stale. Two things then conspired: Graph's delta is not chronological, so the
// creating message is not always the first one sent; and until the contact-form
// parse was gated on the envelope, colleagues' replies were stored under a
// customer's identity and vice versa.
//
// THE RULE IS NARROW ON PURPOSE, because most mismatches are not defects.
//
//   NOT A DEFECT — an internal escalation ABOUT a customer. A colleague opens a
//   thread to chase order #6045 for Julie Lemaire. `sender_label` says internal
//   (who wrote) and the requester says Julie (who it is about). Both are right,
//   and `requester_email_hash` is what joins that ticket to her order. Sixteen
//   tickets look like this and rewriting them would destroy useful linkage --
//   seven of them would lose an order match outright.
//
//   A DEFECT — a colleague's identity on a thread a CUSTOMER is on. Eleven
//   tickets carry `Taha LAMZOUKI` or `Dounia NOUALI` as the requester while a
//   retailer or a consumer is writing on the thread. Nothing joins, and the
//   dashboard names the wrong person.
//
// So a rewrite happens only when the stored requester IS one of our own
// addresses AND the thread has an external sender to replace it with. When in
// doubt, nothing moves.

/**
 * @param ticket    { requester_email_hash }
 * @param messages  the ticket's inbound messages, any order
 * @param isOwnSide (fromEmail) => boolean
 * @returns the message whose sender should be the requester, or null to leave alone
 */
export function requesterFor({ ticket, messages = [], isOwnSide } = {}) {
  const inbound = [...messages]
    .filter((message) => message?.from_email)
    .sort((a, b) => Date.parse(a.received_at ?? '') - Date.parse(b.received_at ?? ''));
  if (inbound.length === 0) {
    return null;
  }

  // The first person on this thread who is not us. No such sender means a purely
  // internal thread, which has no customer to name and is left exactly as it is.
  const external = inbound.find((message) => !isOwnSide(message.from_email));
  if (!external) {
    return null;
  }

  // Only move an identity that is provably ours. A requester that is already
  // external is either correct, or is the customer an internal thread is about —
  // and this cannot tell those apart, so it touches neither.
  const storedIsOwnSide = inbound.some(
    (message) =>
      isOwnSide(message.from_email) &&
      hashIdentifier(message.from_email) === ticket?.requester_email_hash
  );
  if (!storedIsOwnSide) {
    return null;
  }

  return external;
}

/** The directory-backed predicate the repair uses, so callers do not re-derive it. */
export function ownSidePredicate(senderDirectory) {
  return (fromEmail) => OWN_SIDE_LABELS.includes(senderDirectory?.lookup?.(fromEmail)?.label);
}

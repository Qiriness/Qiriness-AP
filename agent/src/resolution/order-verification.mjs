// Decides whether a parsed order number really belongs to the person who wrote
// in — and how sure we are.
//
// Pure: candidate order rows and ticket identity in, a verdict out.
//
// WHY VERIFICATION IS THE POINT, not the lookup. Finding `#4854` in the text is
// trivial. The number a customer quotes can be a typo, someone else's order they
// were forwarded, an invoice number, or an order from a different shop. Writing
// an unverified number onto the ticket would hand every downstream tool — order
// context, tracking, refund decisions — the wrong order with full confidence.
// So a number is only accepted when the order's own contact hash matches the
// ticket's, and everything weaker is labelled as such.

export const CONFIRMED = 'confirmed';
/** Name agrees, but the email is absent or different — corroboration, not proof. */
export const NAME_MATCH = 'name_match';
/** How a confirmed match was reached. Recorded on the ticket, not just logged. */
export const BY_SENDER_EMAIL = 'email';
/**
 * The order's registered address appears in the customer's own message. Named
 * for what is checked, not for the forwarded confirmation that usually causes
 * it — measured over the mailbox, only 3 of the 6 tickets this path resolves
 * carry a recognisable confirmation, and the other 3 are threads that quote the
 * address for some other reason. `confirmation_markers` on the ticket says which
 * kind it was; this constant must not claim to know.
 */
export const BY_MESSAGE_EMAIL = 'message_email';
export const MISMATCH = 'mismatch';
export const NOT_FOUND = 'not_found';
export const NO_CANDIDATE = 'no_candidate';

/** What a human (or a later drafting step) should do about it. */
export const ASK_PURCHASE_EMAIL = 'ask_purchase_email';

/**
 * @param order   the `orders` row for the quoted number, or null
 * @param ticket  { requester_email_hash, requester_name }
 * @param customer the `customers` row the order points at, or null
 * @param messageEmailHashes hashes of every address in the customer's own text,
 *   from confirmation-evidence.mjs. Empty when the caller does not supply them,
 *   which leaves the older behaviour exactly as it was.
 */
export function verifyOrder({ order, ticket, customer = null, messageEmailHashes = [] } = {}) {
  if (!order) {
    return { status: NOT_FOUND, verifiedBy: null, detail: 'No order with that number in this shop.' };
  }

  // THE SAFE PATH. `orders.customer_email_hash` and `tickets.requester_email_hash`
  // are both produced by `hashIdentifier` (sha256 of the trimmed, lowercased
  // address), so they are directly comparable and a match is proof the order
  // belongs to the sender — without either side ever holding the raw address.
  const orderHash = order.customer_email_hash || null;
  const ticketHash = ticket?.requester_email_hash || null;
  const namesAgree = compareNames(ticket, customer);

  if (orderHash && ticketHash && orderHash === ticketHash) {
    return { status: CONFIRMED, verifiedBy: BY_SENDER_EMAIL, detail: 'Order matches the sender’s email.' };
  }

  // THE ADDRESS IS IN THE MESSAGE. The sender did not write from the account
  // that placed the order, but the address that account IS registered to appears
  // somewhere in what they sent us. Overwhelmingly that is a forwarded or pasted
  // order confirmation; it is also sometimes a thread quoting an earlier reply.
  //
  // Quoting the number is weak evidence and always was: a number can be a typo,
  // an invoice reference, or somebody else's. Quoting the number TOGETHER WITH
  // the address it is registered to is a different thing, because the pairing is
  // not something a stranger produces by guessing — and whichever way the two
  // arrived together, they agree on which order the ticket is about, which is
  // the only question this column answers.
  //
  // Ranked above the name check and treated as CONFIRMED, so the number is
  // written: gifts, an order placed by a partner or a parent, and a second
  // mailbox are all normal here, and the desk's position is that answering the
  // person holding the order details is the correct outcome rather than a risk
  // to guard against. `verifiedBy` records which path got there, so the weaker
  // provenance stays visible on the ticket instead of being flattened into the
  // sender-matched case.
  if (orderHash && messageEmailHashes.includes(orderHash)) {
    return {
      status: CONFIRMED,
      verifiedBy: BY_MESSAGE_EMAIL,
      emailStatus: ticketHash ? 'differs' : 'absent',
      detail:
        'The order is registered to a different address, but that address appears in the ' +
        'customer’s own message. Treated as confirmed.'
    };
  }

  // THE NAME IS PART OF THE CHECK, NOT A LAST RESORT. Most people order and
  // write in from the same address, so a match there is proof — but the
  // legitimate exception is common enough to matter: ordered from a personal
  // address, wrote in from a work one. An earlier version refused to look at the
  // name once the emails differed, on the reasoning that agreement afterwards
  // was coincidence. That was wrong: it collapsed "someone else's order" and
  // "same person, second address" into one flat rejection, and the second is the
  // ordinary case.
  //
  // Still never written automatically. Corroboration narrows it to "probably
  // them"; only the customer confirming which address they ordered with settles
  // it, which is what `suggestedAction` exists to trigger.
  if (namesAgree) {
    const emailStatus = orderHash && ticketHash ? 'differs' : 'absent';
    return {
      status: NAME_MATCH,
      verifiedBy: 'name',
      emailStatus,
      suggestedAction: ASK_PURCHASE_EMAIL,
      detail:
        emailStatus === 'differs'
          ? 'Name matches, but the order is registered to a different email — likely the same person ordering from another address. Ask which email was used for the purchase.'
          : 'Name matches, but there is no email on one side to check against. Ask which email was used for the purchase.'
    };
  }

  if (orderHash && ticketHash) {
    // Emails differ AND the names do not agree: the strongest negative available
    // short of the order not existing.
    return {
      status: MISMATCH,
      verifiedBy: null,
      suggestedAction: ASK_PURCHASE_EMAIL,
      detail: 'That order exists but is registered to a different customer.'
    };
  }

  return {
    status: NOT_FOUND,
    verifiedBy: null,
    suggestedAction: ASK_PURCHASE_EMAIL,
    detail: 'Could not tie that order to the sender.'
  };
}

/** True only when both sides carry a usable, matching name. */
function compareNames(ticket, customer) {
  const orderName = normaliseName(customer?.display_name || joinName(customer));
  const ticketName = normaliseName(ticket?.requester_name);
  return Boolean(orderName && ticketName && orderName === ticketName);
}

/**
 * Picks the best outcome across every candidate in the message.
 *
 * A CONFIRMED match wins outright, wherever it appeared in the text — a customer
 * who quotes two numbers and owns one of them is asking about that one. Then a
 * NAME_MATCH, which is the "probably them, ask which address" case. A MISMATCH
 * ranks above a plain not-found because it is a real signal a human should see:
 * the order exists and is somebody else's.
 */
export function chooseResolution(results) {
  const confirmed = results.find((r) => r.status === CONFIRMED);
  if (confirmed) {
    return confirmed;
  }
  const nameMatch = results.find((r) => r.status === NAME_MATCH);
  if (nameMatch) {
    return nameMatch;
  }
  const mismatch = results.find((r) => r.status === MISMATCH);
  if (mismatch) {
    return mismatch;
  }
  return results[0] || { status: NO_CANDIDATE, verifiedBy: null, detail: 'No order number in the message.' };
}

/** Only a confirmed match is safe to write onto the ticket automatically. */
export function isSafeToWrite(status) {
  return status === CONFIRMED;
}

function joinName(customer) {
  if (!customer) {
    return null;
  }
  return [customer.first_name, customer.last_name].filter(Boolean).join(' ') || null;
}

/** Accent- and case-insensitive, so `Marie MARTIN` and `marie martin` agree. */
function normaliseName(value) {
  const text = String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // A single token is too weak to be evidence of anything.
  return text.split(' ').filter(Boolean).length >= 2 ? text : null;
}

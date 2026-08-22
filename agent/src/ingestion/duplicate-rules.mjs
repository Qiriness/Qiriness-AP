// Is this new conversation the same conversation as one we already hold?
//
// PURE, AND DETERMINISTIC BY DESIGN. No model, no embedding, no similarity: the
// consequence of a hit is that a ticket is skipped by the drafting queue, and a
// customer who is wrongly skipped gets no reply at all. Nothing that guesses
// should be allowed to cause that.
//
// TWO RULES, AND THEY CATCH TWO DIFFERENT THINGS. Measured on the corpus
// (2026-08-19): a true double-post exists and is rare -- one sender's identical
// message arriving one second apart under two Graph conversation ids -- while
// the common shape is a conversation SPLIT, where the contact-form ticket and
// the customer's emailed reply land under different conversation ids and become
// two tickets for one exchange. 72 consecutive ticket pairs from one sender fell
// inside 30 days; none fell outside it.
//
// WHAT IS DELIBERATELY NOT A RULE. Same sender plus the same quoted order
// number looks like a third rule and is not safe as one: a customer may
// legitimately open a delivery ticket and then a refund ticket about a single
// order, and linking those would silence the second. It stays out until
// something measures how often that shape is a duplicate rather than a sequel.

/** How far apart two identical messages can be and still be one double-post. */
export const IDENTICAL_BODY_WINDOW_MS = 60 * 60 * 1000;

/**
 * The reasons a link can carry. Mirrors `tickets_duplicate_reason_check`
 * (04_support.sql); a value added here without the constraint fails the write.
 */
export const DUPLICATE_REASONS = ['identical_body', 'reply_chain'];

/**
 * Whitespace and case are the only differences that never make two emails
 * different emails. Nothing else is normalised: stripping punctuation or
 * accents would start merging messages that a person would read as distinct.
 */
export function normaliseBody(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * The ticket this message belongs to, if it is one we already hold.
 *
 * @param candidate  the mapped message plus when it arrived
 * @param priorMessages  messages from the same sender inside the window, each
 *                       carrying `ticket_id`, `internet_message_id`, `body_text`
 *                       and a timestamp. The caller does the narrowing; this
 *                       decides.
 * @returns { ticketId, reason } or null
 */
export function findDuplicate({ candidate, priorMessages = [] } = {}) {
  if (!candidate) {
    return null;
  }

  // RULE 1 -- THE REPLY CHAIN, tried first because it is the strongest evidence
  // there is. `In-Reply-To` and `References` are how every mail client threads,
  // and they name Message-IDs we already store. A match is not a resemblance, it
  // is the sending client telling us which conversation this belongs to.
  const chain = new Set(
    [candidate.in_reply_to, ...(candidate.reference_ids ?? [])].filter(Boolean)
  );
  if (chain.size > 0) {
    const linked = priorMessages.find(
      (message) => message.internet_message_id && chain.has(message.internet_message_id)
    );
    if (linked?.ticket_id) {
      return { ticketId: linked.ticket_id, reason: 'reply_chain' };
    }
  }

  // RULE 2 -- THE DOUBLE-POST. Identical text from one sender inside an hour.
  //
  // THE WINDOW IS THE WHOLE RULE. The same text three days later is a customer
  // chasing us, which is a different thing entirely and is owed an apology
  // rather than silence -- see the drafting rules. An hour is far wider than the
  // one second the real case took and far narrower than any plausible chase.
  const body = normaliseBody(candidate.body_text);
  if (body.length > 0) {
    const twin = priorMessages.find(
      (message) =>
        normaliseBody(message.body_text) === body &&
        withinWindow(candidate.received_at, message.received_at)
    );
    if (twin?.ticket_id) {
      return { ticketId: twin.ticketId ?? twin.ticket_id, reason: 'identical_body' };
    }
  }

  return null;
}

/** Absolute distance, so the order the two arrived in does not matter. */
function withinWindow(a, b) {
  const first = Date.parse(a ?? '');
  const second = Date.parse(b ?? '');
  if (!Number.isFinite(first) || !Number.isFinite(second)) {
    return false;
  }
  return Math.abs(first - second) <= IDENTICAL_BODY_WINDOW_MS;
}

/**
 * The narrow pool `findDuplicate` decides against.
 *
 * NEVER THE WHOLE MAILBOX. The pool is one sender's recent messages, which on
 * this corpus is a handful of rows: 37 senders have more than one ticket at all.
 * Comparing a new email against every stored message would be a table scan to
 * answer a question two indexed filters already answer.
 *
 * THE SENDER KEY IS THE HASH, NOT THE CUSTOMER. 145 of 214 tickets carry a
 * `customer_id` and 203 carry a `requester_email_hash`, so keying on the
 * customer would miss 24% of the pairs — including every sender the resolution
 * pass has not linked to a Shopify account.
 *
 * CLOSED TICKETS STAY IN THE POOL. 51 of the 72 measured pairs had a prior
 * ticket already closed or resolved, because auto-close retires a thread after
 * 28 days of silence — filtering on status would drop most of what this exists
 * to catch. The window is on time, and 30 days covers all of it: no pair fell
 * outside.
 */
export function createDuplicateLookup({ supabase, shopId, select, windowDays = 30 }) {
  return {
    async priorMessages({ requesterEmailHash, before }) {
      if (!requesterEmailHash) {
        return [];
      }

      const since = new Date(
        (Date.parse(before ?? '') || Date.now()) - windowDays * 86400000
      ).toISOString();

      // Tickets from this sender inside the window, whatever their status.
      const tickets = await select(
        supabase,
        'tickets',
        {
          shop_id: shopId,
          requester_email_hash: requesterEmailHash,
          deleted_at: { operator: 'is', value: 'null' },
          last_message_at: { operator: 'gte', value: since }
        },
        'id'
      );
      if (tickets.length === 0) {
        return [];
      }

      // Their inbound messages. Only what the rules read: no bodies of ours, no
      // addresses, no vectors.
      return select(
        supabase,
        'ticket_messages',
        {
          shop_id: shopId,
          direction: 'inbound',
          ticket_id: { operator: 'in', value: `(${tickets.map((t) => t.id).join(',')})` }
        },
        'ticket_id,internet_message_id,body_text,received_at'
      );
    }
  };
}

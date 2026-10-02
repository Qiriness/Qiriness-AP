/**
 * Where a case's reply goes: decided by code, never by a model.
 *
 * THE RULE. Reply to the most recent customer-authored message that no later
 * message of ours answers -- on ANY thread of the case. A case can span several
 * email threads (a customer who writes again under a new conversation); the
 * reply goes on the thread holding that message, whichever it is, so a
 * customer who wrote « toujours rien » on a new thread is answered there, with
 * the whole case behind the answer.
 *
 * WHAT IT IS NOT DECIDED ON: the order rows were stored in, the newest row, or
 * the oldest (« master ») thread. Only the email's own time (`received_at`,
 * falling back to `sent_at`) orders messages.
 *
 * WHO IS THE CUSTOMER: `actor = 'customer'` (stamped at arrival). A row from
 * before the actor column falls back to `direction = 'inbound'`, the same rule
 * the manual reply and the poll gate already use. A colleague's or a partner's
 * message is never a reply target: they are not who we answer.
 *
 * WHAT COUNTS AS AN ANSWER: any outbound message, on any thread of the case,
 * dated after the customer's message. Same semantics as `answeredSince`
 * (agent/src/drafting/draft-rules.mjs), lifted from one thread to the case.
 *
 * An undated message can be neither a target nor an answer: placing it would be
 * a guess, and a guess here either answers the wrong message or silences a
 * customer.
 *
 * Isomorphic (worker and dashboard), and pure.
 */

/** The email's own time, or null. Never the ingestion time. */
export function messageTime(message) {
  const at = message?.received_at || message?.sent_at;
  if (!at) return null;
  const value = Date.parse(at);
  return Number.isNaN(value) ? null : value;
}

export function isCustomerMessage(message) {
  if (message?.direction === 'outbound') return false;
  return (message?.actor ?? 'customer') === 'customer';
}

/**
 * @param messages every message of every thread of the case, any order, each
 *   carrying `id`, `ticket_id`, `direction`, `actor`, `received_at`/`sent_at`
 * @returns { messageId, threadId, at } or null when nothing is owed
 */
export function caseReplyTarget(messages = []) {
  let latestCustomer = null;
  let latestOutbound = null;
  for (const message of messages) {
    if (!message) continue;
    const at = messageTime(message);
    if (at === null) continue;
    if (message.direction === 'outbound') {
      if (latestOutbound === null || at > latestOutbound) latestOutbound = at;
    } else if (isCustomerMessage(message) && message.id) {
      if (!latestCustomer || at > latestCustomer.at) latestCustomer = { message, at };
    }
  }
  if (!latestCustomer) return null;
  // Answered on any thread after it: nothing is owed.
  if (latestOutbound !== null && latestOutbound > latestCustomer.at) return null;
  return {
    messageId: latestCustomer.message.id,
    threadId: latestCustomer.message.ticket_id ?? null,
    at: new Date(latestCustomer.at).toISOString()
  };
}

/**
 * The case's messages in the order the case happened: by the email's own time,
 * undated last, then by thread and id so the order is stable.
 */
export function caseTimeline(messages = []) {
  return [...messages].sort((a, b) => {
    const ta = messageTime(a);
    const tb = messageTime(b);
    if (ta !== tb) {
      if (ta === null) return 1;
      if (tb === null) return -1;
      return ta - tb;
    }
    return String(a?.ticket_id ?? '').localeCompare(String(b?.ticket_id ?? '')) ||
      String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
  });
}

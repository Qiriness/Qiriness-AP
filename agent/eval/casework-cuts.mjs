import { senderRole } from '../src/ingestion/sender-directory.mjs';

// Which threads the multi-turn set is built from, and where each one is cut.
//
// A CUT IS A POINT IN A THREAD: "this message has just landed — what should the
// pipeline decide now, knowing only what came before?" One per message after
// the first. The opening message is the case file's job and already has its own
// evals; there is no prior case for it to change.
//
// BOTH DIRECTIONS ARE CUT. An inbound cut is evidence arriving or a customer
// closing; an outbound cut is what we asked, promised or closed. Nothing in the
// pipeline reads the second kind today, which is the gap the set is for.
//
// PURE: rows in, rows out. The builder does the reading.

/**
 * Why a thread is in the set, or null when it is not.
 *
 * `customer_followup` — the customer wrote at least twice. The 36-thread
 *   population the reconstruction was built on.
 * `other_sender` — a colleague, the 3PL or a carrier wrote on the thread. Where
 *   internal evidence arrives, and where it is mistaken for the customer.
 * `replied_once` — the customer wrote once and we answered. Only whether our
 *   reply closed the case can be asked of it, so it is opt-in.
 *
 * The first that applies wins, so a thread is counted once.
 */
export function threadGroup(conversation, directory = null) {
  const messages = Array.isArray(conversation) ? conversation : [];
  if (messages.length < 2) return null;
  const roles = messages.map((message) => senderRole(message, directory));
  const customer = roles.filter((role) => role === 'customer').length;
  if (customer >= 2) return 'customer_followup';
  if (roles.some((role) => role !== 'customer' && role !== 'qiriness')) return 'other_sender';
  if (roles.includes('qiriness')) return 'replied_once';
  return null;
}

export const DEFAULT_GROUPS = ['customer_followup', 'other_sender'];

/**
 * The cut points of one thread, oldest first.
 *
 * `index` is the message's position in the thread, so the eval can rebuild
 * « everything up to here » from the same read without trusting timestamps a
 * second time. `role` is resolved here and never labelled: the code already
 * knows who wrote, and a label for it would only be a way to disagree with the
 * sender directory in a place nobody looks.
 */
export function cutsFor(conversation, directory = null) {
  const messages = Array.isArray(conversation) ? conversation : [];
  return messages.slice(1).map((message, offset) => ({
    messageId: message.id,
    index: offset + 1,
    direction: message.direction === 'outbound' ? 'outbound' : 'inbound',
    role: senderRole(message, directory),
    at: message.received_at ?? message.sent_at ?? null
  }));
}

/** The thread as the pipeline would have seen it when message `index` landed. */
export function threadUpTo(conversation, index) {
  return (Array.isArray(conversation) ? conversation : []).slice(0, index + 1);
}

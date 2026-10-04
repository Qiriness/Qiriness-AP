import { sendableStatusesFor } from '../../../scripts/lib/outbound-record.mjs';

/**
 * WHETHER AN APPROVED REPLY MAY STILL GO OUT. Pure: the runner gathers the
 * facts from the database the poll has just brought up to date, and this says
 * yes or names the reason it may not.
 *
 * Asked immediately before the provider is called, not when the reply was
 * approved: minutes or hours can pass between a click and the send, and every
 * one of these can change in that time.
 *
 * The order is the order a reviewer would want to read the reason in: the
 * approval itself first, then what happened on the thread.
 *
 * @param {object} facts
 * @param {object} facts.action           the outbound_actions row
 * @param {object|null} facts.draft       its ticket_drafts row (status, auto_send_eligible)
 * @param {object|null} facts.caseCurrent the ticket's case_current row (version)
 * @param {object|null} facts.replyTo     the ticket_messages row being answered
 * @param {object[]} facts.laterMessages  the ticket's messages received after replyTo
 * @param {object[]} facts.otherActions   the ticket's other outbound actions
 * @param {boolean} facts.orderMoved      the order's material signature differs from the bundle's
 * @param {boolean} facts.draftOnly       config.draftOnly
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function preSendCheck({ action, draft, caseCurrent, replyTo, laterMessages = [], otherActions = [], orderMoved = false, draftOnly = true }) {
  if (action.mode === 'manual') return manualCheck({ action, replyTo, laterMessages });

  // The approval still stands: not rejected, not gone stale under a fold. An
  // auto-send's draft must still be pending: a person who touched it owns it.
  if (!draft || !sendableStatusesFor(action.mode).includes(draft.status)) {
    return refuse('draft_withdrawn');
  }

  // Auto-send is gated twice: the global switch, and the draft's own verdict.
  if (action.mode === 'auto_send' && (draftOnly || !draft.auto_send_eligible)) {
    return refuse('auto_send_off');
  }

  // The case this text was written against is still the case.
  if (!caseCurrent || caseCurrent.version !== action.case_version) {
    return refuse('case_moved');
  }

  // The order moved in a way the customer would notice (shipped, cancelled,
  // refunded) and the pipeline has not yet read it: the case version cannot
  // have caught up, so the version check above cannot see it. Covers the
  // sync-only worker, which sends without rebuilding anything, and an order
  // update landing between two polls (DECISIONS § Change router).
  if (orderMoved) {
    return refuse('facts_pending');
  }

  const own = new Set([action.sent_message_id].filter(Boolean));
  const later = laterMessages.filter((message) => message.id !== replyTo?.id && !own.has(message.id));

  // The customer has written again since the message being answered.
  if (later.some((message) => message.direction === 'inbound' && (message.actor ?? 'customer') === 'customer')) {
    return refuse('customer_wrote_again');
  }

  // Somebody already answered: a reply typed in Outlook or from a personal
  // inbox (stored outbound), or another action of ours that went or may have.
  if (later.some((message) => message.direction === 'outbound')) {
    return refuse('already_answered');
  }
  // Only a send for THIS case version or a newer one. A reply to an earlier
  // version is why the customer wrote again; counting it made every ticket
  // that had ever had a reply through here unanswerable (found 2026-09-28 on
  // the second reply of a test thread).
  if (
    otherActions.some(
      (other) =>
        other.id !== action.id &&
        ['send_requested', 'sent_confirmed'].includes(other.state) &&
        !(Number(other.case_version) < Number(action.case_version))
    )
  ) {
    return refuse('already_answered');
  }

  return { ok: true };
}

/**
 * A REPLY A PERSON WROTE is checked for one thing only: whether the customer
 * has written since the message it answers, which the person could not have
 * read. There is no draft to withdraw, and the rest is the person's call —
 * they wrote it knowing our earlier reply had gone (that is usually why they
 * are writing: to add what it missed) and knowing where the case stood.
 */
function manualCheck({ action, replyTo, laterMessages }) {
  const own = new Set([action.sent_message_id].filter(Boolean));
  const later = laterMessages.filter((message) => message.id !== replyTo?.id && !own.has(message.id));
  if (later.some((message) => message.direction === 'inbound' && (message.actor ?? 'customer') === 'customer')) {
    return refuse('customer_wrote_again');
  }
  return { ok: true };
}

function refuse(reason) {
  return { ok: false, reason };
}

import { statusHeld } from '../../../scripts/lib/ticket-overrides.mjs';
import { fallbackWakeAt } from '../../../scripts/lib/snooze-record.mjs';

import { CASE_MANAGED_STATUSES } from './case-status.mjs';

// Whether a fold snoozes a ticket, wakes it, or leaves it. No model: the Case
// Manager's readings and the fold have already said who acts next and what is
// owed; this only asks whether support can do anything before someone else
// does. DECISIONS.md § Snooze.
//
// IT SNOOZES ON THE SEND, NOT ON THE DRAFT. The trigger is a message of ours
// that is new in the thread, and our message is in the thread only once it has
// gone: it comes back through Sent Items. An approved draft, one waiting in
// Outlook's Drafts, or a reply still queued never snoozes anything.
//
// EDGE-TRIGGERED. It fires on « we just sent something », never because a case
// still reads « waiting on the customer ». A ticket its deadline woke is not
// snoozed again until something new happens, which is what keeps a case from
// bouncing between the queue and the Snoozed tab. The index on
// (ticket_id, trigger_message_id) holds the same line in the database.

/** Who we may be waiting on, as `case_current.next_actor` names them. */
const WAITING_ON = ['customer', 'colleague', 'partner'];

/**
 * @param ticket    `{ status, level, deleted_at, archived_at, needs_categorisation, needs_investigation, overrides }`
 * @param state     the folded `case_current`: `{ last_actor, as_of_message_id, as_of_at, next_actor, obligations, version? }`
 * @param previous  the previous fold: `{ as_of_message_id, next_actor }`, or null for a first fold
 * @param openSnooze the ticket's open `ticket_snoozes` row, or null
 * @param alreadySnoozedOn whether this message of ours already snoozed the ticket once
 * @param parameters the shop's parameter map (the delays)
 * @param lastCustomerAt when the customer last wrote: a person's status holds until then
 * @param keepOpenLevels levels only a person handles (4)
 * @returns `{ action: 'snooze', waitingFor, wakeAt, triggerMessageId }` | `{ action: 'retarget', snoozeId, waitingFor, wakeAt }`
 *   | `{ action: 'wake', reason, detail? }` | `{ action: null, reason }`
 */
export function snoozeDecision({
  ticket,
  state,
  previous = null,
  openSnooze = null,
  alreadySnoozedOn = false,
  parameters = new Map(),
  lastCustomerAt = null,
  keepOpenLevels = [],
  now = new Date()
}) {
  if (!ticket || !state) return { action: null, reason: 'no_case' };

  // WAKE: the case has just come back to us, or ended. On the change only: a
  // person may snooze a case that is already ours (« follow up Friday »), and a
  // later fold that still says « ours » must not undo that.
  if (openSnooze) {
    const moved = previous && previous.next_actor !== state.next_actor;
    if (moved && state.next_actor === 'support') return { action: 'wake', reason: 'case_changed' };
    if (moved && state.next_actor === 'nobody') return { action: 'wake', reason: 'resolved' };

    // RETARGET: an automatic snooze whose case now waits on someone else (we
    // told the customer « we're asking the carrier », then asked Deret). The
    // row must name who we wait on: the order-update wake reads it, and so do
    // the deadline and the Snoozed tab. The new party is judged as a fresh
    // snooze would be, so a case that turned into work wakes instead. A
    // person's snooze is theirs and is left alone.
    if (moved && openSnooze.source === 'auto' && WAITING_ON.includes(state.next_actor) && state.next_actor !== openSnooze.waiting_for) {
      const blocked = whyNotWaiting({ ticket, state, lastCustomerAt, keepOpenLevels });
      if (blocked) return { action: 'wake', reason: 'case_changed', detail: blocked };
      const wakeAt = fallbackWakeAt({ waitingFor: state.next_actor, from: state.as_of_at ?? now, parameters });
      if (!wakeAt) return { action: 'wake', reason: 'case_changed', detail: 'no_deadline' };
      if (wakeAt.getTime() <= now.getTime()) return { action: 'wake', reason: 'deadline' };
      return { action: 'retarget', snoozeId: openSnooze.id, waitingFor: state.next_actor, wakeAt };
    }
    return { action: null, reason: 'already_snoozed' };
  }

  const ourNewMessage =
    previous !== null && state.last_actor === 'support' && Boolean(state.as_of_message_id) && state.as_of_message_id !== previous.as_of_message_id;
  if (!ourNewMessage) return { action: null, reason: 'no_new_message_of_ours' };
  if (alreadySnoozedOn) return { action: null, reason: 'already_snoozed_on_message' };

  const blocked = whyNotWaiting({ ticket, state, lastCustomerAt, keepOpenLevels });
  if (blocked) return { action: null, reason: blocked };

  const waitingFor = state.next_actor;
  const wakeAt = fallbackWakeAt({ waitingFor, from: state.as_of_at ?? now, parameters });
  if (!wakeAt) return { action: null, reason: 'no_deadline' };
  if (wakeAt.getTime() <= now.getTime()) return { action: null, reason: 'deadline_passed' };

  return { action: 'snooze', waitingFor, wakeAt, triggerMessageId: state.as_of_message_id };
}

/** Why this case is not simply waiting on someone else, or null when it is. */
function whyNotWaiting({ ticket, state, lastCustomerAt, keepOpenLevels }) {
  if (ticket.deleted_at || ticket.archived_at) return 'archived';
  if (!CASE_MANAGED_STATUSES.includes(ticket.status)) return 'not_ours';
  if (statusHeld(ticket.overrides, lastCustomerAt)) return 'held_by_person';
  if (keepOpenLevels.includes(Number(ticket.level))) return 'level_kept_open';
  if (ticket.needs_categorisation || ticket.needs_investigation) return 'pass_pending';
  if (!WAITING_ON.includes(state.next_actor)) return 'not_waiting';

  // SOMETHING SUPPORT CAN DO NOW keeps the case in the queue: a check we owe,
  // or a colleague's / partner's check a rule opened that nobody has written to
  // them about yet (opened_by 'rule', not a message). « Deret needs asking » is
  // work; « Deret has been asked » is waiting.
  const pending = (state.obligations ?? []).filter((o) => o.status === 'pending');
  if (pending.some((o) => o.owner === 'support')) return 'support_owes_a_check';
  if (pending.some((o) => o.owner !== 'support' && o.opened_by === 'rule')) return 'request_not_sent';
  return null;
}

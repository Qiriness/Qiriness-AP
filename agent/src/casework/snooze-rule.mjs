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
 * @returns `{ action: 'snooze', waitingFor, wakeAt, triggerMessageId }` | `{ action: 'wake', reason }` | `{ action: null, reason }`
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
    return { action: null, reason: 'already_snoozed' };
  }

  const ourNewMessage =
    previous !== null && state.last_actor === 'support' && Boolean(state.as_of_message_id) && state.as_of_message_id !== previous.as_of_message_id;
  if (!ourNewMessage) return { action: null, reason: 'no_new_message_of_ours' };
  if (alreadySnoozedOn) return { action: null, reason: 'already_snoozed_on_message' };

  if (ticket.deleted_at || ticket.archived_at) return { action: null, reason: 'archived' };
  if (!CASE_MANAGED_STATUSES.includes(ticket.status)) return { action: null, reason: 'not_ours' };
  if (statusHeld(ticket.overrides, lastCustomerAt)) return { action: null, reason: 'held_by_person' };
  if (keepOpenLevels.includes(Number(ticket.level))) return { action: null, reason: 'level_kept_open' };
  if (ticket.needs_categorisation || ticket.needs_investigation) return { action: null, reason: 'pass_pending' };

  const waitingFor = state.next_actor;
  if (!WAITING_ON.includes(waitingFor)) return { action: null, reason: 'not_waiting' };

  // SOMETHING SUPPORT CAN DO NOW keeps the case in the queue: a check we owe,
  // or a colleague's / partner's check a rule opened that nobody has written to
  // them about yet (opened_by 'rule', not a message). « Deret needs asking » is
  // work; « Deret has been asked » is waiting.
  const pending = (state.obligations ?? []).filter((o) => o.status === 'pending');
  if (pending.some((o) => o.owner === 'support')) return { action: null, reason: 'support_owes_a_check' };
  if (pending.some((o) => o.owner !== 'support' && o.opened_by === 'rule')) {
    return { action: null, reason: 'request_not_sent' };
  }

  const wakeAt = fallbackWakeAt({ waitingFor, from: state.as_of_at ?? now, parameters });
  if (!wakeAt) return { action: null, reason: 'no_deadline' };
  if (wakeAt.getTime() <= now.getTime()) return { action: null, reason: 'deadline_passed' };

  return { action: 'snooze', waitingFor, wakeAt, triggerMessageId: state.as_of_message_id };
}

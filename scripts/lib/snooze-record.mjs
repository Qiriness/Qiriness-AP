import { days } from './parameters.mjs';
import { supabaseInsert, supabaseSelect, supabaseUpdate } from './supabase-rest-client.mjs';
import { T } from './tables.mjs';
import { addWorkingDays } from './working-days.mjs';

/**
 * The `ticket_snoozes` row, and the only module that writes it.
 *
 * A snooze hides a case from the queue until something happens. It is NOT a
 * ticket status: the status still says who acts next (casework/case-status.mjs),
 * and the categoriser and the investigation still claim `status = 'open'`. The
 * open row (woke_at null) is the ticket's current snooze; older rows are the
 * history, kept so an automatic snooze a person undid early stays visible.
 *
 * Shared by the worker (the fold snoozes, ingestion and the sweep wake) and the
 * dashboard (a person snoozes and wakes), as outbound-record is.
 *
 * EVERY WAKE IS CONDITIONAL ON THE SNOOZE BEING OPEN, so a customer's message
 * and the deadline sweep racing on one ticket wake it once, with one reason.
 */

/** Mirrors ticket_snoozes_source_check; 54_ticket_snoozes.test.mjs asserts it. */
export const SNOOZE_SOURCES = ['auto', 'manual'];

/** Mirrors ticket_snoozes_waiting_for_check. `partner` is an operations partner (3PL, carrier). */
export const WAITING_FOR = ['customer', 'colleague', 'partner', 'date'];

/** Mirrors ticket_snoozes_wake_reason_check. */
export const WAKE_REASONS = [
  'customer_message',
  'colleague_message',
  'partner_message',
  'deadline',
  'manual',
  'case_changed',
  'resolved',
  'order_update'
];

/**
 * How long a case waiting on each party stays snoozed, at most: a parameter
 * per shop, in working days. Colleague and partner reuse the overdue delays,
 * so the case comes back exactly when the check turns overdue.
 */
export const FALLBACK_PARAMETER = Object.freeze({
  customer: 'customer_reply_wait_days',
  colleague: 'colleague_check_overdue_days',
  partner: 'partner_check_overdue_days'
});

/** The longest a person may snooze a ticket for. Past that it is not waiting, it is forgotten. */
export const MAX_SNOOZE_DAYS = 60;

export const SNOOZE_COLUMNS =
  'id,ticket_id,source,waiting_for,reason,wake_at,trigger_message_id,case_version,snoozed_by,snoozed_at,woke_at,wake_reason,woken_by';

/** The wake reason for a new message from this actor, or null (our own mail wakes nothing). */
export function wakeReasonForActor(actor) {
  if (actor === 'customer') return 'customer_message';
  if (actor === 'colleague') return 'colleague_message';
  if (actor === 'partner') return 'partner_message';
  return null;
}

/**
 * When a case waiting on `waitingFor` comes back at the latest, or null when
 * the shop has not set that delay (and so must not snooze it automatically).
 *
 * @param {{ waitingFor: string, from: string | Date, parameters: Map<string, unknown> }} input
 */
export function fallbackWakeAt({ waitingFor, from, parameters }) {
  const key = FALLBACK_PARAMETER[waitingFor];
  if (!key) return null;
  const count = days(parameters, key);
  if (count === null || count < 1) return null;
  return addWorkingDays(from, count);
}

/**
 * The row for a snooze, or a reason it cannot be written. Pure.
 *
 * @param {{ ticketId: string, source: string, waitingFor: string, wakeAt: string | Date | null,
 *   reason?: string | null, triggerMessageId?: string | null, caseVersion?: number | null,
 *   snoozedBy?: string | null, now?: Date }} input
 */
export function snoozeRow({
  ticketId,
  source,
  waitingFor,
  wakeAt,
  reason = null,
  triggerMessageId = null,
  caseVersion = null,
  snoozedBy = null,
  now = new Date()
}) {
  if (!ticketId) return { error: 'no_ticket' };
  if (!SNOOZE_SOURCES.includes(source)) return { error: 'bad_source' };
  if (!WAITING_FOR.includes(waitingFor)) return { error: 'bad_waiting_for' };
  const wake = new Date(wakeAt ?? '');
  if (!Number.isFinite(wake.getTime())) return { error: 'no_wake_at' };
  if (wake.getTime() <= now.getTime()) return { error: 'wake_in_past' };
  if (wake.getTime() - now.getTime() > MAX_SNOOZE_DAYS * 86_400_000) return { error: 'too_far' };
  if (source === 'auto' && !triggerMessageId) return { error: 'no_trigger' };
  const text = typeof reason === 'string' ? reason.trim().slice(0, 300) : '';
  return {
    row: {
      ticket_id: ticketId,
      source,
      waiting_for: waitingFor,
      reason: text || null,
      wake_at: wake.toISOString(),
      trigger_message_id: triggerMessageId,
      case_version: Number.isInteger(caseVersion) ? caseVersion : null,
      snoozed_by: snoozedBy
    }
  };
}

export const REST_TRANSPORT = {
  select: supabaseSelect,
  insert: supabaseInsert,
  update: supabaseUpdate
};

export function createSnoozeRecord(supabase, { shopId, transport = REST_TRANSPORT }) {
  if (!shopId) {
    throw new Error('createSnoozeRecord requires a shopId: every read and write here is shop-scoped.');
  }
  const { select, insert, update } = transport;

  async function open(ticketId) {
    const rows = await select(
      supabase,
      T.TICKET_SNOOZES,
      { shop_id: shopId, ticket_id: ticketId, woke_at: { operator: 'is', value: 'null' } },
      SNOOZE_COLUMNS,
      { limit: 1 }
    );
    return rows[0] ?? null;
  }

  return {
    open,

    /**
     * Insert a snooze (a row from `snoozeRow`). THE INDEX DECIDES: a ticket
     * already snoozed, or a message of ours already snoozed on, collides and
     * returns `created: false` with the open snooze, if there is one.
     */
    async snooze(row) {
      try {
        const [created] = await insert(supabase, T.TICKET_SNOOZES, [{ shop_id: shopId, ...row }]);
        return { created: true, snooze: created ?? null };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        return { created: false, snooze: await open(row.ticket_id) };
      }
    },

    /**
     * Wake the ticket's open snooze. Returns the woken row, or null when nothing was open.
     * @param {string} ticketId
     * @param {string} reason
     * @param {{ wokenBy?: string | null, at?: Date }} [options]
     */
    async wake(ticketId, reason, { wokenBy = null, at = new Date() } = {}) {
      if (!WAKE_REASONS.includes(reason)) {
        throw new Error(`wake takes one of ${WAKE_REASONS.join(', ')}; got ${JSON.stringify(reason)}.`);
      }
      const rows = await update(
        supabase,
        T.TICKET_SNOOZES,
        { shop_id: shopId, ticket_id: ticketId, woke_at: { operator: 'is', value: 'null' } },
        { woke_at: at.toISOString(), wake_reason: reason, woken_by: wokenBy },
        { select: SNOOZE_COLUMNS }
      );
      return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    },

    /**
     * Point an open automatic snooze at the party the case now waits on, with
     * that party's deadline. In place, not a wake and a new row: nothing came
     * back to the queue, so the Snoozed tab must not show it returning. The
     * trigger message stays, so the edge-trigger index still holds. Returns
     * the updated row, or null when it was no longer open or not automatic.
     * @param {string} snoozeId
     * @param {{ waitingFor: string, wakeAt: string | Date, caseVersion?: number | null, now?: Date }} change
     */
    async retarget(snoozeId, { waitingFor, wakeAt, caseVersion = null, now = new Date() }) {
      if (!WAITING_FOR.includes(waitingFor) || waitingFor === 'date') {
        throw new Error(`retarget takes customer, colleague or partner; got ${JSON.stringify(waitingFor)}.`);
      }
      const wake = new Date(wakeAt ?? '');
      if (!Number.isFinite(wake.getTime()) || wake.getTime() <= now.getTime()) {
        throw new Error(`retarget needs a deadline after now; got ${JSON.stringify(wakeAt)}.`);
      }
      if (wake.getTime() - now.getTime() > MAX_SNOOZE_DAYS * 86_400_000) {
        throw new Error(`retarget deadline is past ${MAX_SNOOZE_DAYS} days.`);
      }
      const rows = await update(
        supabase,
        T.TICKET_SNOOZES,
        { shop_id: shopId, id: snoozeId, source: 'auto', woke_at: { operator: 'is', value: 'null' } },
        { waiting_for: waitingFor, wake_at: wake.toISOString(), case_version: Number.isInteger(caseVersion) ? caseVersion : null },
        { select: SNOOZE_COLUMNS }
      );
      return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    },

    /** Open snoozes whose deadline has passed, oldest first. */
    async due({ now = new Date(), limit = 200 } = {}) {
      return select(
        supabase,
        T.TICKET_SNOOZES,
        { shop_id: shopId, woke_at: { operator: 'is', value: 'null' }, wake_at: { operator: 'lte', value: now.toISOString() } },
        SNOOZE_COLUMNS,
        { order: 'wake_at.asc', limit }
      );
    },

    /** Every open snooze in the shop: the queue hides these. */
    async allOpen() {
      return select(supabase, T.TICKET_SNOOZES, { shop_id: shopId, woke_at: { operator: 'is', value: 'null' } }, SNOOZE_COLUMNS, {
        order: 'wake_at.asc'
      });
    },

    /** Snoozes woken since `since`: the queue marks a ticket that just came back. */
    async wokenSince(since) {
      return select(
        supabase,
        T.TICKET_SNOOZES,
        { shop_id: shopId, woke_at: { operator: 'gte', value: new Date(since).toISOString() } },
        SNOOZE_COLUMNS,
        { order: 'woke_at.desc' }
      );
    },

    /** Whether the fold already snoozed this ticket on this message of ours. */
    async autoSnoozedOn(ticketId, messageId) {
      if (!messageId) return false;
      const rows = await select(
        supabase,
        T.TICKET_SNOOZES,
        { shop_id: shopId, ticket_id: ticketId, source: 'auto', trigger_message_id: messageId },
        'id',
        { limit: 1 }
      );
      return rows.length > 0;
    }
  };
}

function isUniqueViolation(error) {
  return /duplicate key|unique constraint|ticket_snoozes_open_key|ticket_snoozes_auto_trigger_key/i.test(String(error?.message ?? ''));
}

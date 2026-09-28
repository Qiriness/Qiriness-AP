import { supabaseInsert, supabaseSelect, supabaseUpdate } from './supabase-rest-client.mjs';
import { T } from './tables.mjs';

/**
 * The `outbound_actions` row, and the only module that writes it.
 *
 * A row is a reply we have DECIDED to send. The dashboard creates one when a
 * person approves a draft; the outbound worker is the only thing that turns it
 * into mail (agent/src/outbound/outbound-runner.mjs). Lives in scripts/lib so
 * both runtimes share one writer, as ticket-record and draft-record do.
 *
 * EVERY STATE MOVE IS CONDITIONAL ON THE STATE IT LEAVES. Two workers, or a
 * worker and a dashboard, can race on one row; a move written as "set X where
 * state is Y" loses the race harmlessly instead of overwriting the winner.
 * Each returns whether it moved the row.
 *
 * NO RECIPIENT. Nothing here takes or stores an address; the worker reads it
 * from the answered message at send time.
 */

/** Mirrors outbound_actions_state_check; 47_outbound_actions.test.mjs asserts it. */
export const OUTBOUND_STATES = ['approved', 'draft_created', 'send_requested', 'sent_confirmed', 'cancelled', 'failed'];

/** Mirrors outbound_actions_mode_check. */
export const OUTBOUND_MODES = ['human_approved', 'auto_send'];

/** States in which an action may still produce mail. */
export const OPEN_STATES = ['approved', 'draft_created', 'send_requested'];

/**
 * Why a pre-send check refused. Documented on the column; the test holds the
 * comment to this list.
 */
export const CANCEL_REASONS = ['case_moved', 'customer_wrote_again', 'already_answered', 'draft_withdrawn', 'auto_send_off'];

const ACTION_COLUMNS =
  'id,ticket_id,draft_id,case_version,action_type,mode,requested_by,reply_to_message_id,body_text,state,' +
  'cancel_reason,failure_reason,provider,provider_draft_id,provider_internet_message_id,sent_message_id,' +
  'draft_created_at,send_requested_at,confirmed_at,closed_at,created_at';

/** Draft statuses a send may be made from: what a person approved. */
export const SENDABLE_DRAFT_STATUSES = ['approved', 'edited'];

/**
 * The draft statuses an action of this mode may still go out from. An
 * auto-send never had a person's approval, so it goes from `pending` (nobody
 * rejected it and the case has not moved); anything a person touched is theirs.
 */
export function sendableStatusesFor(mode) {
  return mode === 'auto_send' ? ['pending'] : SENDABLE_DRAFT_STATUSES;
}

/**
 * The row to insert for a draft, or a reason it cannot be sent. Pure.
 *
 * A draft from before stage 6 has no case version, and the version is the
 * idempotency key, so it cannot be sent through here: approve its successor.
 *
 * @param {object|null} draft  a ticket_drafts row
 * @param {{ mode?: string, requestedBy?: string | null }} [options]
 */
export function actionFromDraft(draft, { mode = 'human_approved', requestedBy = null } = {}) {
  if (!draft) return { error: 'no_draft' };
  if (!sendableStatusesFor(mode).includes(draft.status)) return { error: 'not_approved' };
  if (mode === 'auto_send' && !(draft.auto_send_eligible && draft.checks_passed)) return { error: 'not_eligible' };
  if (!Number.isInteger(draft.case_version) || draft.case_version < 1) return { error: 'no_case_version' };
  const bodyText = typeof draft.approved_body_text === 'string' && draft.approved_body_text.trim() !== ''
    ? draft.approved_body_text
    : draft.body_text;
  if (typeof bodyText !== 'string' || bodyText.trim() === '') return { error: 'empty_body' };
  if (!OUTBOUND_MODES.includes(mode)) return { error: 'bad_mode' };
  return {
    row: {
      ticket_id: draft.ticket_id,
      draft_id: draft.id,
      case_version: draft.case_version,
      action_type: 'reply',
      mode,
      requested_by: requestedBy,
      reply_to_message_id: draft.trigger_message_id,
      body_text: bodyText
    }
  };
}

export const REST_TRANSPORT = {
  select: supabaseSelect,
  insert: supabaseInsert,
  update: supabaseUpdate
};

export function createOutboundRecord(supabase, { shopId, transport = REST_TRANSPORT }) {
  if (!shopId) {
    throw new Error('createOutboundRecord requires a shopId: every read and write here is shop-scoped.');
  }
  const { select, insert, update } = transport;

  async function move(id, fromStates, patch) {
    const rows = await update(
      supabase,
      T.OUTBOUND_ACTIONS,
      { id, shop_id: shopId, state: { operator: 'in', value: `(${fromStates.join(',')})` } },
      patch,
      { select: 'id' }
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  // The action holding the key: the one not cancelled or failed.
  async function forVersion(ticketId, caseVersion) {
    const rows = await select(
      supabase,
      T.OUTBOUND_ACTIONS,
      {
        shop_id: shopId,
        ticket_id: ticketId,
        case_version: caseVersion,
        action_type: 'reply',
        state: { operator: 'not.in', value: '(cancelled,failed)' }
      },
      ACTION_COLUMNS,
      { limit: 1 }
    );
    return rows[0] ?? null;
  }

  return {
    /**
     * Insert the action for a draft. THE KEY DECIDES, not a read beforehand:
     * a second approval of the same case version collides with the unique
     * index on (shop_id, ticket_id, case_version, action_type) over live rows
     * and gets the existing row back with `created: false`.
     */
    async create(row) {
      try {
        const [created] = await insert(supabase, T.OUTBOUND_ACTIONS, [{ shop_id: shopId, state: 'approved', ...row }]);
        return { created: true, action: created ?? null };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        return { created: false, action: await forVersion(row.ticket_id, row.case_version) };
      }
    },

    async get(id) {
      const rows = await select(supabase, T.OUTBOUND_ACTIONS, { id, shop_id: shopId }, ACTION_COLUMNS, { limit: 1 });
      return rows[0] ?? null;
    },

    /** Every action on a ticket, newest first. */
    async forTicket(ticketId) {
      return select(supabase, T.OUTBOUND_ACTIONS, { shop_id: shopId, ticket_id: ticketId }, ACTION_COLUMNS, {
        order: 'created_at.desc'
      });
    },

    /** Actions whose mail may have gone and is not confirmed yet. */
    async awaitingConfirmation({ limit = 100 } = {}) {
      return select(
        supabase,
        T.OUTBOUND_ACTIONS,
        { shop_id: shopId, state: { operator: 'in', value: '(draft_created,send_requested)' } },
        ACTION_COLUMNS,
        { order: 'created_at.asc', limit }
      );
    },

    markDraftCreated(id, { providerDraftId, internetMessageId = null, at = new Date() }) {
      return move(id, ['approved'], {
        state: 'draft_created',
        provider_draft_id: providerDraftId,
        provider_internet_message_id: internetMessageId,
        draft_created_at: at.toISOString()
      });
    },

    /** Written BEFORE the send call: from here on the row means "maybe sent". */
    markSendRequested(id, at = new Date()) {
      return move(id, ['draft_created', 'send_requested'], { state: 'send_requested', send_requested_at: at.toISOString() });
    },

    /**
     * Ingestion stored the sent mail. From draft_created too: a person may have
     * sent the draft from Outlook themselves.
     */
    markConfirmed(id, { sentMessageId, at = new Date() }) {
      return move(id, ['draft_created', 'send_requested'], {
        state: 'sent_confirmed',
        sent_message_id: sentMessageId,
        confirmed_at: at.toISOString(),
        closed_at: at.toISOString()
      });
    },

    /**
     * A pre-send check refused. From send_requested only with `confirmedUnsent`:
     * the caller has just asked the mailbox and the reply is still a draft.
     */
    cancel(id, reason, { at = new Date(), confirmedUnsent = false } = {}) {
      if (!CANCEL_REASONS.includes(reason)) {
        throw new Error(`cancel takes one of ${CANCEL_REASONS.join(', ')}; got ${JSON.stringify(reason)}.`);
      }
      const from = confirmedUnsent ? ['approved', 'draft_created', 'send_requested'] : ['approved', 'draft_created'];
      return move(id, from, { state: 'cancelled', cancel_reason: reason, closed_at: at.toISOString() });
    },

    markFailed(id, reason, at = new Date()) {
      return move(id, OPEN_STATES, { state: 'failed', failure_reason: String(reason ?? '').slice(0, 500), closed_at: at.toISOString() });
    }
  };
}

function isUniqueViolation(error) {
  return /duplicate key|unique constraint|outbound_actions_idempotency_key/i.test(String(error?.message ?? ''));
}

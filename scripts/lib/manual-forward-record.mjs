/**
 * The one writer of `ticket_manual_forwards` (06_manual_forwards.sql): a person
 * forwarding a ticket's whole thread to colleagues from the dashboard.
 *
 * Shared by the dashboard (which creates the row and queues the job) and the
 * worker (which carries it: agent/src/outbound/forward-ticket.mjs). Every move
 * is conditional on the state it moves from, so two holders of one job cannot
 * both send.
 *
 *   queued → draft_created → send_requested → sent
 *                          ↘ held   (OUTBOUND_STOP_BEFORE_SEND: left in Drafts)
 *   any    → failed
 *
 * A SEND IS NEVER RETRIED BLIND, as for replies: `send_requested` is written
 * before the call, and a job finding a forward there asks the mailbox where the
 * draft is before doing anything more.
 */
import {
  supabaseInsert,
  supabaseSelect,
  supabaseUpdate
} from './supabase-rest-client.mjs';
import { T } from './tables.mjs';

/** Mirrors ticket_manual_forwards_state_check. */
export const FORWARD_STATES = ['queued', 'draft_created', 'send_requested', 'sent', 'held', 'failed'];

/** The states a forward is still on its way in: the page polls while one is. */
export const FORWARD_IN_FLIGHT = ['queued', 'draft_created', 'send_requested'];

/** What `mail_jobs` deduplicates a forward's job on. */
export function forwardDedupeKey(forwardId) {
  return `forward:${forwardId}`;
}

const COLUMNS =
  'id,ticket_id,client_key,recipients,note,forwarded_by,forwarded_by_name,state,source_message_id,' +
  'provider_draft_id,internet_message_id,attachments_sent,attachments_skipped,error,sent_at,created_at';

export function createManualForwardRecord(supabase, { shopId }) {
  if (!shopId) throw new Error('createManualForwardRecord requires a shopId.');

  const move = async (id, from, patch) => {
    const rows = await supabaseUpdate(
      supabase,
      T.TICKET_MANUAL_FORWARDS,
      { id, shop_id: shopId, state: Array.isArray(from) ? { operator: 'in', value: `(${from.join(',')})` } : from },
      patch,
      { select: COLUMNS }
    );
    return (Array.isArray(rows) ? rows[0] : rows) ?? null;
  };

  return {
    /** Inserts the forward. The same `client_key` twice returns the first row, unchanged. */
    async create(row) {
      const existing = await supabaseSelect(
        supabase,
        T.TICKET_MANUAL_FORWARDS,
        { shop_id: shopId, client_key: row.client_key },
        COLUMNS,
        { limit: 1 }
      );
      if (existing[0]) return { created: false, forward: existing[0] };
      const [forward] = await supabaseInsert(supabase, T.TICKET_MANUAL_FORWARDS, [{ ...row, shop_id: shopId, state: 'queued' }]);
      return { created: true, forward };
    },

    async get(id) {
      const rows = await supabaseSelect(supabase, T.TICKET_MANUAL_FORWARDS, { id, shop_id: shopId }, COLUMNS, { limit: 1 });
      return rows[0] ?? null;
    },

    /** A ticket's forwards, oldest first: what the conversation shows. */
    async forTicket(ticketId) {
      return supabaseSelect(supabase, T.TICKET_MANUAL_FORWARDS, { ticket_id: ticketId, shop_id: shopId }, COLUMNS, {
        order: 'created_at.asc'
      });
    },

    /** The draft exists at the provider; nothing has been sent. */
    markDraftCreated(id, { sourceMessageId, providerDraftId, internetMessageId, attachmentsSkipped }) {
      return move(id, 'queued', {
        state: 'draft_created',
        source_message_id: sourceMessageId,
        provider_draft_id: providerDraftId,
        internet_message_id: internetMessageId,
        attachments_skipped: attachmentsSkipped ?? [],
        error: null
      });
    },

    /** Written BEFORE the send call: a crash between the two leaves « maybe sent ». */
    markSendRequested(id, { attachmentsSent }) {
      return move(id, 'draft_created', { state: 'send_requested', attachments_sent: attachmentsSent });
    },

    markSent(id) {
      return move(id, ['draft_created', 'send_requested'], { state: 'sent', sent_at: new Date().toISOString(), error: null });
    },

    markHeld(id, { attachmentsSent }) {
      return move(id, 'draft_created', { state: 'held', attachments_sent: attachmentsSent });
    },

    /** A draft made but never sent is thrown away and the forward starts again. */
    restart(id) {
      return move(id, 'draft_created', { state: 'queued', provider_draft_id: null, internet_message_id: null, attachments_sent: 0 });
    },

    markFailed(id, error) {
      return move(id, FORWARD_IN_FLIGHT, { state: 'failed', error: String(error ?? 'failed').slice(0, 500) });
    },

    /** « Retry » on the page: only a failed forward goes back in the queue. */
    retry(id) {
      return move(id, 'failed', { state: 'queued', error: null, provider_draft_id: null, internet_message_id: null, attachments_sent: 0 });
    }
  };
}

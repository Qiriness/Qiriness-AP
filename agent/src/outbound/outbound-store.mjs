import { supabaseSelect } from '../../../scripts/lib/supabase-rest-client.mjs';
import { T } from '../../../scripts/lib/tables.mjs';

const MESSAGE_COLUMNS = 'id,ticket_id,graph_message_id,internet_message_id,direction,actor,from_email,received_at';
const DRAFT_COLUMNS =
  'id,ticket_id,trigger_message_id,status,case_version,auto_send_eligible,checks_passed,body_text,approved_body_text,' +
  // What actionFromDraft builds the HTML from: the formatted rewrite, and the
  // link a [[marker]] stands for.
  'approved_body_html,reply_link';

/**
 * The reads the outbound worker needs, and nothing else. Every write goes
 * through the record modules (outbound-record, draft-record); this only
 * gathers the facts `preSendCheck` and the confirmation step judge.
 */
export function createOutboundStore(supabase, { shopId, select = supabaseSelect }) {
  if (!shopId) throw new Error('createOutboundStore requires a shopId.');

  return {
    async draft(draftId) {
      const rows = await select(
        supabase,
        T.TICKET_DRAFTS,
        { id: draftId, shop_id: shopId },
        DRAFT_COLUMNS,
        { limit: 1 }
      );
      return rows[0] ?? null;
    },

    /**
     * Drafts the level gate would send by itself: pending, eligible, checks
     * passed, written against a case version. Oldest first. Only read with
     * DRAFT_ONLY off.
     */
    async autoSendCandidates({ limit = 50 } = {}) {
      return select(
        supabase,
        T.TICKET_DRAFTS,
        {
          shop_id: shopId,
          status: 'pending',
          auto_send_eligible: true,
          checks_passed: true,
          case_version: { operator: 'not.is', value: 'null' }
        },
        DRAFT_COLUMNS,
        { order: 'drafted_at.asc', limit }
      );
    },

    /** Which of these drafts already have an outbound action. */
    async draftsWithActions(draftIds) {
      const ids = [...new Set(draftIds.filter(Boolean))];
      if (ids.length === 0) return new Set();
      const rows = await select(
        supabase,
        T.OUTBOUND_ACTIONS,
        { shop_id: shopId, draft_id: { operator: 'in', value: `(${ids.join(',')})` } },
        'draft_id'
      );
      return new Set(rows.map((row) => row.draft_id));
    },

    async caseCurrent(ticketId) {
      const rows = await select(supabase, T.CASE_CURRENT, { ticket_id: ticketId, shop_id: shopId }, 'ticket_id,version', { limit: 1 });
      return rows[0] ?? null;
    },

    async message(messageId) {
      const rows = await select(supabase, T.TICKET_MESSAGES, { id: messageId, shop_id: shopId }, MESSAGE_COLUMNS, { limit: 1 });
      return rows[0] ?? null;
    },

    /**
     * The messages received after `after` on EVERY thread of the ticket's case,
     * oldest first (61_cases.sql). A customer who writes again on another
     * thread of the case, or a colleague who answers there, is the same
     * « wrote again » / « already answered » as on this thread: `preSendCheck`
     * reads them unchanged. A ticket with no case reads its own thread.
     */
    async messagesAfter(ticketId, after) {
      if (!after) return [];
      const [ticket] = await select(supabase, T.TICKETS, { id: ticketId, shop_id: shopId }, 'id,case_id', { limit: 1 });
      const threads = ticket?.case_id
        ? await select(supabase, T.TICKETS, { case_id: ticket.case_id, shop_id: shopId, deleted_at: { operator: 'is', value: 'null' } }, 'id')
        : [];
      const ids = [...new Set([ticketId, ...threads.map((row) => row.id)])];
      return select(
        supabase,
        T.TICKET_MESSAGES,
        {
          ticket_id: ids.length === 1 ? ticketId : { operator: 'in', value: `(${ids.join(',')})` },
          shop_id: shopId,
          received_at: { operator: 'gt', value: after }
        },
        MESSAGE_COLUMNS,
        { order: 'received_at.asc' }
      );
    },

    /**
     * The stored copy of a reply we sent, once ingestion has read it back from
     * Sent Items: by the draft's immutable id first, then by Internet-Message-Id
     * (the fallback if ids were ever read in REST form).
     */
    async storedSentMessage({ providerDraftId, internetMessageId }) {
      if (providerDraftId) {
        const rows = await select(
          supabase,
          T.TICKET_MESSAGES,
          { shop_id: shopId, graph_message_id: providerDraftId },
          MESSAGE_COLUMNS,
          { limit: 1 }
        );
        if (rows[0]) return rows[0];
      }
      if (internetMessageId) {
        const rows = await select(
          supabase,
          T.TICKET_MESSAGES,
          { shop_id: shopId, internet_message_id: internetMessageId, direction: 'outbound' },
          MESSAGE_COLUMNS,
          { limit: 1 }
        );
        if (rows[0]) return rows[0];
      }
      return null;
    }
  };
}

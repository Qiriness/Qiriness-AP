import {
  supabaseSelect,
  supabaseSelectAll,
  supabaseUpdate,
  supabaseUpsert
} from '../../../scripts/lib/supabase-rest-client.mjs';
import { T } from '../../../scripts/lib/tables.mjs';

/**
 * How many times a message is re-attempted before it is left alone.
 *
 * Exists because retrying is now the default: without a cap, a message with a
 * genuinely undeliverable recipient would be re-sent on every poll forever. Five
 * is enough to ride out a mailbox move or a Graph outage and small enough that a
 * real misconfiguration surfaces the same day.
 */
export const MAX_FORWARD_ATTEMPTS = 5;

// DB access for forwarding: the destinations and the switch, the mail waiting
// to go, the router's decisions, and a record of every attempt.
//
// Kept apart from the runner so the decisions (forward-rules.mjs,
// destination-router.mjs) and the side effects (Graph) can both be tested
// without a database.

export function createForwardingStore(supabase) {
  return {
    /**
     * Everything the pass needs to know before looking at mail: every
     * destination (switched-off ones included, so a stale decision pointing at
     * one is recognised), the settings row and the shop's name.
     */
    async loadConfig(shopId) {
      const [destinations, settingsRows, shops] = await Promise.all([
        supabaseSelectAll(supabase, T.FORWARDING_DESTINATIONS, { shop_id: shopId }, '*', { order: 'position.asc' }),
        supabaseSelect(
          supabase,
          T.FORWARDING_SETTINGS,
          { shop_id: shopId },
          'ack_enabled,ack_template_fr,ack_template_en,forward_since'
        ),
        supabaseSelect(supabase, T.SHOPS, { id: shopId }, 'shop_name')
      ]);
      return {
        destinations,
        settings: settingsRows?.[0] ?? { ack_enabled: false, forward_since: null },
        shopName: shops?.[0]?.shop_name ?? ''
      };
    },

    /**
     * Tickets in the routed categories with inbound mail received since the
     * switch was turned on that has not been forwarded, each with its current
     * decision and whether we have replied on it.
     *
     * Selects on ticket state rather than on what this poll wrote, so mail
     * missed by a crashed run, or routed only after a category was corrected,
     * is caught up on the next pass.
     *
     * `received_at >= since` is the whole backlog guard: the mail's own
     * timestamp, so a re-enumeration replaying old mail cannot pass it.
     */
    async findPending(shopId, { since, categories }) {
      if (!since || categories.length === 0) return [];

      const messages = await supabaseSelectAll(
        supabase,
        T.TICKET_MESSAGES,
        {
          shop_id: shopId,
          direction: 'inbound',
          received_at: { operator: 'gte', value: since },
          deleted_at: { operator: 'is', value: 'null' }
        },
        'id,ticket_id,graph_message_id,from_email,subject,received_at',
        { order: 'received_at.asc' }
      );
      if (messages.length === 0) return [];

      const ledger = await supabaseSelectAll(
        supabase,
        T.TICKET_FORWARDS,
        { shop_id: shopId },
        'ticket_message_id,status,attempts'
      );
      // Only `sent` is final. A `failed` row is retried until the cap, because
      // the common failure is transient — Exchange mid-mailbox-move returned
      // ErrorMailboxMoveInProgress for all 42 messages on the first real run.
      const done = new Set();
      const priorAttempts = new Map();
      for (const row of ledger) {
        if (row.status === 'sent' || (row.attempts ?? 1) >= MAX_FORWARD_ATTEMPTS) {
          done.add(row.ticket_message_id);
        } else {
          priorAttempts.set(row.ticket_message_id, row.attempts ?? 1);
        }
      }
      const open = messages.filter((m) => !done.has(m.id));
      if (open.length === 0) return [];

      const ticketIds = [...new Set(open.map((m) => m.ticket_id))];
      const tickets = await supabaseSelectAll(
        supabase,
        T.TICKETS,
        {
          shop_id: shopId,
          id: { operator: 'in', value: `(${ticketIds.join(',')})` },
          category: { operator: 'in', value: `(${categories.join(',')})` },
          // Spam is never anyone's; a linked duplicate is the same email twice,
          // and its original already went.
          status: { operator: 'neq', value: 'spam' },
          duplicate_of_ticket_id: { operator: 'is', value: 'null' },
          deleted_at: { operator: 'is', value: 'null' }
        },
        'id,subject,category,request_kind,language,status'
      );
      if (tickets.length === 0) return [];
      const routedIds = tickets.map((t) => t.id);

      const [routing, outbound] = await Promise.all([
        supabaseSelectAll(
          supabase,
          T.TICKET_ROUTING,
          { shop_id: shopId, ticket_id: { operator: 'in', value: `(${routedIds.join(',')})` } },
          '*'
        ),
        supabaseSelectAll(
          supabase,
          T.TICKET_MESSAGES,
          {
            shop_id: shopId,
            direction: 'outbound',
            ticket_id: { operator: 'in', value: `(${routedIds.join(',')})` },
            deleted_at: { operator: 'is', value: 'null' }
          },
          'ticket_id'
        )
      ]);
      const routingByTicket = new Map(routing.map((r) => [r.ticket_id, r]));
      const replied = new Set(outbound.map((m) => m.ticket_id));

      return tickets.map((ticket) => ({
        ticket,
        routing: routingByTicket.get(ticket.id) ?? null,
        hasOutbound: replied.has(ticket.id),
        messages: open
          .filter((m) => m.ticket_id === ticket.id)
          .map((m) => ({
            messageId: m.id,
            graphMessageId: m.graph_message_id,
            fromEmail: m.from_email,
            subject: m.subject,
            receivedAt: m.received_at,
            priorAttempts: priorAttempts.get(m.id) ?? 0
          }))
      }));
    },

    /** What the router reads: the inbound thread, oldest first. */
    async loadThread(ticketId) {
      return supabaseSelectAll(
        supabase,
        T.TICKET_MESSAGES,
        { ticket_id: ticketId, direction: 'inbound', deleted_at: { operator: 'is', value: 'null' } },
        'subject,body_text,from_email,received_at',
        { order: 'received_at.asc' }
      );
    },

    /**
     * Acknowledgements that failed and may be tried again, each with the
     * message it answers: the first one forwarded on its ticket.
     */
    async findAckRetries(shopId, { maxAttempts }) {
      const failed = await supabaseSelectAll(
        supabase,
        T.TICKET_ROUTING,
        { shop_id: shopId, ack_state: 'failed', ack_attempts: { operator: 'lt', value: maxAttempts } },
        '*'
      );
      const out = [];
      for (const routing of failed) {
        const [first] = await supabaseSelect(
          supabase,
          T.TICKET_FORWARDS,
          { ticket_id: routing.ticket_id, status: 'sent' },
          'ticket_message_id',
          { order: 'created_at.asc', limit: 1 }
        );
        if (!first) continue;
        const [[message], [ticket]] = await Promise.all([
          supabaseSelect(supabase, T.TICKET_MESSAGES, { id: first.ticket_message_id }, 'id,graph_message_id,from_email'),
          supabaseSelect(supabase, T.TICKETS, { id: routing.ticket_id }, 'id,language')
        ]);
        if (message && ticket) out.push({ routing, ticket, message });
      }
      return out;
    },

    /**
     * Whether ANOTHER thread of this ticket's case was already acknowledged
     * (61_cases.sql): a customer who splits one problem across two threads is
     * acknowledged once, not once per thread.
     */
    async caseAcknowledged(ticketId) {
      const [ticket] = await supabaseSelect(supabase, T.TICKETS, { id: ticketId }, 'id,case_id', { limit: 1 });
      if (!ticket?.case_id) return false;
      const threads = await supabaseSelectAll(supabase, T.TICKETS, { case_id: ticket.case_id }, 'id');
      const others = threads.map((row) => row.id).filter((id) => id !== ticketId);
      if (others.length === 0) return false;
      const sent = await supabaseSelect(
        supabase,
        T.TICKET_ROUTING,
        { ticket_id: { operator: 'in', value: `(${others.join(',')})` }, ack_state: 'sent' },
        'ticket_id',
        { limit: 1 }
      );
      return sent.length > 0;
    },

    /** The router's decision, one row per ticket, replaced when re-decided. */
    async recordRouting(shopId, ticket, decision) {
      const [row] = await supabaseUpsert(
        supabase,
        T.TICKET_ROUTING,
        [
          {
            shop_id: shopId,
            ticket_id: ticket.id,
            category: ticket.category,
            request_kind: ticket.request_kind ?? null,
            outcome: decision.outcome,
            method: decision.method,
            destination_id: decision.destination?.id ?? null,
            destination_label: decision.destination?.label ?? null,
            reason: decision.reason ?? null,
            model: decision.model ?? null,
            decided_at: new Date().toISOString()
          }
        ],
        'ticket_id'
      );
      return row;
    },

    /**
     * Records a forward attempt. Written after the send, never before: a row
     * here means « this really went out » (or « this really failed »).
     *
     * UPSERT on `ticket_message_id`: a retry has to be able to move its row
     * from `failed` to `sent`, and an insert would collide with the constraint.
     */
    async recordForward({ shopId, ticketId, messageId, category, address, destinationLabel, error, priorAttempts = 0 }) {
      await supabaseUpsert(
        supabase,
        T.TICKET_FORWARDS,
        [
          {
            shop_id: shopId,
            ticket_id: ticketId,
            ticket_message_id: messageId,
            category,
            forward_email: address,
            destination_label: destinationLabel ?? null,
            status: error ? 'failed' : 'sent',
            error: error ? String(error).slice(0, 300) : null,
            attempts: priorAttempts + 1
          }
        ],
        'ticket_message_id'
      );
    },

    /** Moves the acknowledgement on. `requested` is written before the send. */
    async recordAck(ticketId, { state, error = null, attempts }) {
      const patch = { ack_state: state, ack_error: error ? String(error).slice(0, 300) : null };
      if (attempts !== undefined) patch.ack_attempts = attempts;
      if (state === 'sent') patch.ack_at = new Date().toISOString();
      await supabaseUpdate(supabase, T.TICKET_ROUTING, { ticket_id: ticketId }, patch);
    }
  };
}

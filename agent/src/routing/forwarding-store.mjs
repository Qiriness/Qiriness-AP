import {
  supabaseSelectAll,
  supabaseUpsert
} from '../../../scripts/lib/supabase-rest-client.mjs';

/**
 * How many times a message is re-attempted before it is left alone.
 *
 * Exists because retrying is now the default: without a cap, a message with a
 * genuinely undeliverable recipient would be re-sent on every poll forever. Five
 * is enough to ride out a mailbox move or a Graph outage and small enough that a
 * real misconfiguration surfaces the same day.
 */
export const MAX_FORWARD_ATTEMPTS = 5;

// DB access for forwarding: read the address book, find the mail that qualifies
// and has not been forwarded yet, and record each attempt.
//
// Kept apart from the runner so the decision logic (forward-rules.mjs) and the
// side effects (Graph) can both be tested without a database.

export function createForwardingStore(supabase) {
  return {
    /** category -> address. Only rows with a usable address are returned. */
    async loadAddressBook(shopId) {
      const rows = await supabaseSelectAll(
        supabase,
        'category_forwarding',
        { shop_id: shopId },
        'category,forward_email'
      );
      const book = new Map();
      for (const row of rows) {
        const address = String(row.forward_email || '').trim();
        if (address.includes('@')) {
          book.set(row.category, address);
        }
      }
      return book;
    },

    /**
     * Inbound messages on `contact`-kind tickets in the categories that have an
     * address, minus anything already forwarded.
     *
     * Selects on the ticket state rather than on what the current poll wrote, so
     * mail missed by a crashed run, or by a category configured only today, is
     * caught up on the next pass. That is the same catch-up property the
     * categorisation step relies on.
     *
     * `direction = 'inbound'` matters: the mailbox stores our own replies too,
     * and forwarding one of those to a colleague would be nonsense.
     */
    async findPending(shopId, categories) {
      if (categories.length === 0) {
        return [];
      }

      const tickets = await supabaseSelectAll(
        supabase,
        'tickets',
        {
          shop_id: shopId,
          request_kind: 'contact',
          category: { operator: 'in', value: `(${categories.join(',')})` },
          deleted_at: { operator: 'is', value: 'null' }
        },
        'id,category,subject,request_kind'
      );
      if (tickets.length === 0) {
        return [];
      }
      const ticketById = new Map(tickets.map((t) => [t.id, t]));

      const messages = await supabaseSelectAll(
        supabase,
        'ticket_messages',
        {
          shop_id: shopId,
          direction: 'inbound',
          deleted_at: { operator: 'is', value: 'null' }
        },
        'id,ticket_id,graph_message_id,from_email,subject,received_at',
        { order: 'received_at.asc' }
      );

      // Only `sent` is final. A `failed` row is retried until the cap, because
      // the common failure is transient — Exchange mid-mailbox-move returned
      // ErrorMailboxMoveInProgress for all 42 messages on the first real run,
      // and treating any row as "done" would have meant that mail never went.
      const ledger = await supabaseSelectAll(
        supabase,
        'ticket_forwards',
        { shop_id: shopId },
        'ticket_message_id,status,attempts'
      );
      const done = new Set();
      const priorAttempts = new Map();
      for (const row of ledger) {
        if (row.status === 'sent' || (row.attempts ?? 1) >= MAX_FORWARD_ATTEMPTS) {
          done.add(row.ticket_message_id);
        } else {
          priorAttempts.set(row.ticket_message_id, row.attempts ?? 1);
        }
      }

      return messages
        .filter((m) => ticketById.has(m.ticket_id) && !done.has(m.id))
        .map((m) => ({
          messageId: m.id,
          graphMessageId: m.graph_message_id,
          fromEmail: m.from_email,
          subject: m.subject,
          priorAttempts: priorAttempts.get(m.id) ?? 0,
          ticket: ticketById.get(m.ticket_id)
        }));
    },

    /**
     * Records the attempt. Written after the send, never before: a row here
     * means "this really went out" (or "this really failed").
     *
     * UPSERT, not insert. `unique (ticket_message_id)` is still what guarantees
     * one row per message — but a retry has to be able to update that row from
     * `failed` to `sent`, and an insert would simply collide with the
     * constraint. `attempts` carries forward from what the selection step read.
     */
    async recordForward({ shopId, ticketId, messageId, category, address, error, priorAttempts = 0 }) {
      await supabaseUpsert(
        supabase,
        'ticket_forwards',
        [
          {
            shop_id: shopId,
            ticket_id: ticketId,
            ticket_message_id: messageId,
            category,
            forward_email: address,
            status: error ? 'failed' : 'sent',
            error: error ? String(error).slice(0, 300) : null,
            attempts: priorAttempts + 1
          }
        ],
        'ticket_message_id'
      );
    }
  };
}

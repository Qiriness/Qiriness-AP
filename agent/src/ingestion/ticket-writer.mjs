import {
  supabaseSelect,
  supabaseInsert,
  supabaseUpsert,
  supabaseUpdateById
} from '../../../scripts/lib/supabase-rest-client.mjs';

// Persists mapped Graph messages into tickets / ticket_messages.
//
// The store interface is injected so the threading + idempotency logic can be
// unit-tested without a database; createSupabaseTicketStore is the real impl.
// Threading: one ticket per (shop_id, conversationId). Idempotency: messages are
// upserted on (shop_id, graph_message_id), so re-ingesting the same email is a no-op.

export async function writeIngestedMessages(store, shopId, mapped) {
  const counts = { ticketsCreated: 0, messagesIngested: 0, removed: 0 };

  for (const item of mapped) {
    if (item.removed) {
      counts.removed += 1;
      continue;
    }

    const ticket = await getOrCreateTicket(store, shopId, item.conversation);
    if (ticket.created) {
      counts.ticketsCreated += 1;
    }

    await store.upsertMessage({ ...item.message, ticket_id: ticket.id, shop_id: shopId });
    counts.messagesIngested += 1;
  }

  return counts;
}

async function getOrCreateTicket(store, shopId, conversation) {
  const existing = await store.findTicketByConversation(shopId, conversation.graph_conversation_id);

  if (existing) {
    // Advance last_message_at as the thread grows; backfill a subject only if the
    // ticket never had one. first_message_at is left as the first message we saw.
    const patch = {};
    if (isLater(conversation.message_at, existing.last_message_at)) {
      patch.last_message_at = conversation.message_at;
    }
    if (!existing.subject && conversation.subject) {
      patch.subject = conversation.subject;
    }
    if (Object.keys(patch).length > 0) {
      await store.updateTicket(existing.id, patch);
    }
    return { id: existing.id, created: false };
  }

  const inserted = await store.insertTicket({
    shop_id: shopId,
    graph_conversation_id: conversation.graph_conversation_id,
    subject: conversation.subject,
    requester_email_hash: conversation.requester_email_hash,
    requester_name: conversation.requester_name,
    first_message_at: conversation.message_at,
    last_message_at: conversation.message_at
  });

  return { id: inserted.id, created: true };
}

function isLater(candidate, current) {
  if (!candidate) {
    return false;
  }
  if (!current) {
    return true;
  }
  return new Date(candidate).getTime() > new Date(current).getTime();
}

export function createSupabaseTicketStore(supabase) {
  return {
    async findTicketByConversation(shopId, conversationId) {
      const rows = await supabaseSelect(
        supabase,
        'tickets',
        { shop_id: shopId, graph_conversation_id: conversationId },
        'id,subject,last_message_at'
      );
      return rows[0] || null;
    },

    async insertTicket(row) {
      const rows = await supabaseInsert(supabase, 'tickets', [row]);
      return rows[0];
    },

    async updateTicket(ticketId, patch) {
      await supabaseUpdateById(supabase, 'tickets', ticketId, patch);
    },

    async upsertMessage(row) {
      await supabaseUpsert(supabase, 'ticket_messages', [row], 'shop_id,graph_message_id');
    }
  };
}

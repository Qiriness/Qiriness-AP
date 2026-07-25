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

// triage (optional): async (item) => { spam: boolean }. Runs only on the first
// message of a *new* conversation (where spam arrives), before anything is
// created — so classified spam is dropped and never stored. Replies into an
// existing ticket are never triaged, so a genuine follow-up can't be discarded.
export async function writeIngestedMessages(store, shopId, mapped, { triage } = {}) {
  const counts = { ticketsCreated: 0, messagesIngested: 0, removed: 0, llmSpamFiltered: 0 };

  for (const item of mapped) {
    if (item.removed) {
      counts.removed += 1;
      continue;
    }

    const ticketId = await resolveTicket(store, shopId, item, triage, counts);
    if (ticketId === null) {
      continue; // dropped by the LLM spam pass — never written
    }

    await store.upsertMessage({ ...item.message, ticket_id: ticketId, shop_id: shopId });
    counts.messagesIngested += 1;
  }

  return counts;
}

async function resolveTicket(store, shopId, item, triage, counts) {
  const conversation = item.conversation;
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
    return existing.id;
  }

  // New conversation: run the LLM spam pass (if configured) before creating anything.
  if (triage) {
    const verdict = await triage(item);
    if (verdict.spam) {
      counts.llmSpamFiltered += 1;
      return null;
    }
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
  counts.ticketsCreated += 1;
  return inserted.id;
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

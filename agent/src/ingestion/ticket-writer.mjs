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

// triage (optional): async (item) => { spam: boolean, label, reason, model, error }.
// Runs only on the first message of a *new* conversation (where spam arrives),
// before anything is created — so classified spam is dropped and never stored.
// Replies into an existing ticket are never triaged, so a genuine follow-up can't
// be discarded (and therefore produces no audit row: no decision was made).
//
// audit (optional): a spam-audit collector. Every triage verdict, keep or drop, is
// recorded — for a dropped email the audit row is the only trace that survives.
//
// embedMessage (optional): async (message) => embedding columns | null. Runs
// before the upsert so the row is written complete, and is best-effort by
// contract — a null result simply stores the message without a vector, which the
// reconciler fills in later.
export async function writeIngestedMessages(
  store,
  shopId,
  mapped,
  { triage, audit, embedMessage, logger } = {}
) {
  const counts = {
    ticketsCreated: 0,
    messagesIngested: 0,
    messagesEmbedded: 0,
    removed: 0,
    llmSpamFiltered: 0
  };

  for (const item of mapped) {
    if (item.removed) {
      counts.removed += 1;
      continue;
    }

    const ticketId = await resolveTicket(store, shopId, item, triage, counts, audit);
    if (ticketId === null) {
      continue; // dropped by the LLM spam pass — never written
    }

    const message = { ...item.message, ticket_id: ticketId, shop_id: shopId };
    // Defence in depth: createMessageEmbedder already swallows its own failures,
    // but the "an embedding never fails ingestion" guarantee belongs here, at the
    // call site, so it holds for whatever embedder is injected.
    const embedding = await tryEmbed(embedMessage, message, logger);
    await store.upsertMessage(embedding ? { ...message, ...embedding } : message);
    counts.messagesIngested += 1;
    if (embedding) {
      counts.messagesEmbedded += 1;
    }
  }

  return counts;
}

async function resolveTicket(store, shopId, item, triage, counts, audit) {
  const conversation = item.conversation;
  const existing = await store.findTicketByConversation(shopId, conversation.graph_conversation_id);

  if (existing) {
    // Keep the ticket's window around the whole thread: extend it in either
    // direction, and backfill a subject only if the ticket never had one.
    //
    // first_message_at moves BACKWARDS as well as forwards because Graph's delta
    // does not return messages in chronological order. On an initial enumeration
    // of an existing mailbox a thread is routinely opened by one of its later
    // replies, so "the first message we saw" is not the first message sent —
    // measured on a real inbox it was late on 93 of 171 tickets, by 5 days on
    // average and 24 at worst. The categoriser's queue is ordered on this column,
    // so leaving it at whatever arrived first quietly mis-sorts the backlog.
    const patch = {};
    if (isLater(conversation.message_at, existing.last_message_at)) {
      patch.last_message_at = conversation.message_at;
    }
    if (isEarlier(conversation.message_at, existing.first_message_at)) {
      patch.first_message_at = conversation.message_at;
    }
    if (!existing.subject && conversation.subject) {
      patch.subject = conversation.subject;
    }
    // A new message from the customer can change what the ticket is about, and
    // above all what it now needs — an order question that becomes a lost parcel,
    // a polite thread that turns into a threat to sue. Put the ticket back in the
    // categoriser's queue so its labels describe the conversation as it stands
    // rather than as it opened (03_categorisation.sql).
    //
    // Inbound only: our own replies advance last_message_at too, and
    // re-categorising a thread because WE answered it would pay the model to
    // re-read a conversation the customer has not added anything to.
    if (item.message?.direction === 'inbound') {
      patch.needs_categorisation = true;

      // A customer writing back reopens the ticket. Auto-close (see
      // lifecycle/auto-close.mjs) retires a thread after three weeks of
      // silence; without this, the reply would land on a closed ticket and
      // nobody would see it — the queue would be tidy and wrong.
      //
      // Inbound only, and deliberately: a ticket does not reopen because WE
      // sent something. The lifecycle timestamps are cleared with the status,
      // or a reopened ticket still reads as finished to anything looking at
      // closed_at rather than at status.
      if (existing.status === 'closed' || existing.status === 'resolved') {
        patch.status = 'open';
        patch.closed_at = null;
        patch.resolved_at = null;
      }

      // Backfill the requester if the ticket has none. Graph's delta is not
      // chronological, so a thread can be opened by one of OUR replies — which
      // carries no requester by design — and the customer's own message then
      // arrives afterwards. Without this the ticket keeps a null requester and
      // drops out of order matching entirely.
      if (!existing.requester_email_hash && conversation.requester_email_hash) {
        patch.requester_email_hash = conversation.requester_email_hash;
      }
      if (!existing.requester_name && conversation.requester_name) {
        patch.requester_name = conversation.requester_name;
      }
    }
    if (Object.keys(patch).length > 0) {
      await store.updateTicket(existing.id, patch);
    }
    return existing.id;
  }

  // New conversation: run the LLM spam pass (if configured) before creating
  // anything. Inbound only — our own reply is not a candidate for spam, and
  // triaging it would spend a model call to judge text the team wrote.
  if (triage && item.message?.direction === 'inbound') {
    const verdict = await triage(item);
    audit?.record({
      graphMessageId: item.graphMessageId ?? item.message?.graph_message_id,
      conversationId: conversation.graph_conversation_id,
      fromEmail: item.message?.from_email,
      subject: item.message?.subject,
      outcome: verdict.spam ? 'blocked' : 'kept',
      decidedBy: 'llm',
      reason: verdict.reason,
      label: verdict.label,
      model: verdict.model,
      failedOpen: Boolean(verdict.error)
    });
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

/**
 * Runs the injected embedder, swallowing anything it throws. An embedding is an
 * optimisation; an ingested email is the product. A missing vector degrades
 * retrieval to the category filter and is repaired by the reconciler, whereas a
 * failed ingestion loses the email outright.
 */
async function tryEmbed(embedMessage, message, logger) {
  if (!embedMessage) {
    return null;
  }
  try {
    return await embedMessage(message);
  } catch (error) {
    // No PII: the body never reaches the log.
    logger?.warn?.('ingest.embed_failed', { message: error.message });
    return null;
  }
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

function isEarlier(candidate, current) {
  if (!candidate) {
    return false;
  }
  if (!current) {
    return true;
  }
  return new Date(candidate).getTime() < new Date(current).getTime();
}

export function createSupabaseTicketStore(supabase) {
  return {
    async findTicketByConversation(shopId, conversationId) {
      const rows = await supabaseSelect(
        supabase,
        'tickets',
        { shop_id: shopId, graph_conversation_id: conversationId },
        // `status` is read so a reply can reopen a ticket auto-close retired.
        'id,status,subject,first_message_at,last_message_at,requester_email_hash,requester_name'
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

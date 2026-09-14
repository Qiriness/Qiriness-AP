import { supabaseSelectAll, supabaseUpsert } from '../../../scripts/lib/supabase-rest-client.mjs';
import { T } from '../../../scripts/lib/tables.mjs';

// How many Graph message ids go into one `in.(...)` filter. They are ~150
// characters each and the filter travels in the URL, so this is a URL-length
// bound rather than a row-count one.
//
// MEASURED, NOT ESTIMATED (2026-09-14). 100 failed on every attempt
// (`fetch failed`) — 399 of 400 real ids carry `+`, `/` or `=`, each encoded
// to three characters — while 75 succeeded. So the guard failed open on every
// full page, which is exactly the re-sync it exists for. 50 leaves margin.
export const KNOWN_ID_CHUNK = 50;

// Persists mapped Graph messages into tickets / ticket_messages.
//
// TWO COLLABORATORS, both injected so the threading + idempotency logic can be
// unit-tested without a database: the MESSAGE store below, which owns
// `ticket_messages` and is the only writer of it anywhere, and the shared TICKET
// record (scripts/lib/ticket-record.mjs), which owns the row this file threads
// messages onto.
//
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
  // The message store owns `ticket_messages` — the upsert below is the ONLY
  // writer of that table. Everything the thread's ticket row needs goes through
  // the shared ticket record.
  store,
  record,
  shopId,
  mapped,
  // detectDuplicate (optional): async (item) => { ticketId, reason } | null.
  // detectRelated  (optional): async ({ ticketId, message, requesterEmailHash })
  //   => { ticketId, score, chased } | null.
  // senderLabel    (optional): (fromEmail) => 'internal' | 'contractor' | null.
  // Runs ONLY when a new conversation is about to become a ticket, which is the
  // only moment a duplicate can be created. Optional like the others, so a
  // caller that has not wired it behaves exactly as before.
  { triage, audit, embedMessage, detectDuplicate, detectRelated, senderLabel, logger } = {}
) {
  const counts = {
    ticketsCreated: 0,
    messagesIngested: 0,
    messagesEmbedded: 0,
    removed: 0,
    llmSpamFiltered: 0,
    duplicatesLinked: 0,
    relatedLinked: 0
  };

  // WHICH OF THESE MESSAGES WE ALREADY HOLD, asked once for the whole page.
  //
  // THE REASON THIS EXISTS IS A MEASURED FAILURE. Two of the effects below —
  // re-raising `needs_categorisation` and reopening a closed thread — are state
  // CHANGES, and they were being applied to every inbound message the writer
  // saw, whether or not it was new. The message upsert is idempotent; those two
  // were not. So a delta re-enumeration, which legitimately re-delivers mail we
  // already store, walked the corpus and reopened it: measured 2026-08-20, of
  // 136 auto-closed tickets that came back to `open`, **128 were triggered by a
  // message already in the database** and only 10 by a genuinely new one. It
  // also re-flagged 374 of 400 tickets for categorisation, which is a model bill
  // for re-reading conversations nobody had added to.
  //
  // One `in.()` query per page rather than a lookup per message: a full
  // enumeration is thousands of messages, and this must not turn into thousands
  // of round trips to protect against something that only happens on a re-sync.
  //
  // OPTIONAL BY CONTRACT. A store without the method (the unit tests' fake, and
  // any caller written before this) yields an empty set, so every message reads
  // as new and the behaviour is exactly what it was. That is deliberate: the
  // guard makes a re-sync safe, and its absence can never make ingestion fail.
  const knownMessageIds = await readKnownMessageIds(store, shopId, mapped, logger);

  for (const item of mapped) {
    if (item.removed) {
      counts.removed += 1;
      continue;
    }

    const isNewMessage = !knownMessageIds.has(item.graphMessageId ?? item.message?.graph_message_id);

    const ticketId = await resolveTicket(
      record, shopId, item, triage, counts, audit, detectDuplicate, senderLabel, logger, isNewMessage
    );
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

    // AFTER THE EMBEDDING, AND THAT IS THE WHOLE REASON IT IS NOT UP THERE WITH
    // THE DUPLICATE CHECK. The duplicate rules compare headers and text, which
    // the mapper already has; this one compares vectors, and the candidate has
    // no vector until the line above ran. Running it beside `detectDuplicate`
    // would silently compare against nothing and never link anything.
    //
    // Failure is never fatal: a related link is an improvement to a reply, and
    // losing one must not cost us the message it was about.
    if (detectRelated && message.direction === 'inbound' && embedding) {
      try {
        const hit = await detectRelated({
          ticketId,
          message: { ...message, ...embedding },
          // The sender key lives on the CONVERSATION, not the message: the
          // mapper puts it there because it is what identifies the requester.
          requesterEmailHash: item.conversation?.requester_email_hash ?? null
        });
        if (hit?.ticketId && hit.ticketId !== ticketId) {
          await record.linkRelated(ticketId, { toTicketId: hit.ticketId, score: hit.score });
          counts.relatedLinked += 1;
          logger?.info?.('ingest.related_linked', {
            ticketId,
            relatedTo: hit.ticketId,
            score: Number(hit.score.toFixed(4)),
            chased: Boolean(hit.chased)
          });
        }
      } catch (error) {
        logger?.warn?.('ingest.related_check_failed', { ticketId, error: error.message });
      }
    }
  }

  return counts;
}

async function resolveTicket(
  record, shopId, item, triage, counts, audit, detectDuplicate, senderLabel, logger,
  // Whether this message is one we did not already hold. Only the two state
  // CHANGES below consult it; everything else here is idempotent and runs either
  // way. Defaults true so a caller that does not know behaves as before.
  isNewMessage = true
) {
  const conversation = item.conversation;
  const existing = await record.findByConversation(conversation.graph_conversation_id);

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
    // rather than as it opened (04_support.sql).
    //
    // Inbound only: our own replies advance last_message_at too, and
    // re-categorising a thread because WE answered it would pay the model to
    // re-read a conversation the customer has not added anything to.
    // INBOUND **AND NEW**. Re-delivery is not arrival: the delta returns mail we
    // already hold whenever the cursor is re-seeded, and treating that as a
    // customer writing back is what reopened 128 settled threads and re-billed
    // the categoriser for 374. `isNewMessage` is the whole guard; see the note
    // at the top of this file, and DECISIONS.md § Re-delivery is not arrival.
    if (item.message?.direction === 'inbound' && isNewMessage) {
      patch.needs_categorisation = true;

      // A customer writing back reopens the ticket. Auto-close (see
      // lifecycle/auto-close.mjs) retires a thread after four weeks of
      // silence; without this, the reply would land on a closed ticket and
      // nobody would see it — the queue would be tidy and wrong.
      //
      // Inbound only, and deliberately: a ticket does not reopen because WE
      // sent something. The lifecycle timestamps are cleared with the status,
      // or a reopened ticket still reads as finished to anything looking at
      // closed_at rather than at status.
      // ANY non-open status, not just the terminal two. `awaiting_customer` is
      // the case that makes this load-bearing rather than tidy: both the
      // categoriser and the investigation runner select on `status = 'open'`, so
      // a ticket parked awaiting a reply would never be re-read once that reply
      // arrived — the customer answers the question we asked and the pipeline
      // never looks again. Stranded, silently, forever.
      if (existing.status && existing.status !== 'open') {
        patch.status = 'open';
        patch.closed_at = null;
        patch.resolved_at = null;
      }
    }

    // Backfill the requester if the ticket has none. Graph's delta is not
    // chronological, so a thread can be opened by one of OUR replies — which
    // carries no requester by design — and the customer's own message then
    // arrives afterwards. Without this the ticket keeps a null requester and
    // drops out of order matching entirely.
    //
    // OUTSIDE THE `isNewMessage` GATE, and that is the distinction the gate is
    // drawing. This is a REPAIR of a null column, not a reaction to an arrival:
    // it is idempotent, it costs nothing, and a re-sync is precisely when you
    // want it to run — re-delivering the customer's message is the second chance
    // to learn who they are.
    if (item.message?.direction === 'inbound') {
      if (!existing.requester_email_hash && conversation.requester_email_hash) {
        patch.requester_email_hash = conversation.requester_email_hash;
      }
      if (!existing.requester_name && conversation.requester_name) {
        patch.requester_name = conversation.requester_name;
      }
    }
    // `recordMessageArrival` sends nothing when the patch is empty — the
    // emptiness check that used to be here is the record's now, because every
    // caller of it wanted the same thing.
    await record.recordMessageArrival(existing.id, patch);
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
      // Written only when this verdict drops the mail (buildAuditRow enforces
      // that): a kept email is stored in full on ticket_messages a moment later,
      // and copying it here too would duplicate personal data into a second
      // table with a second retention clock.
      bodyText: item.message?.body_text,
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

  // WHO OPENED THIS THREAD, decided here and never revisited. A colleague's
  // thread does not become a customer's because a customer is cc'd on message
  // four, and the address that started it is the only one that says whose
  // conversation this is.
  //
  // A fact, not a judgement: no model is asked, because the answer is already
  // in the address. Null for a consumer, which is the ordinary case.
  const ownSide = senderLabel?.(item.message?.from_email) ?? null;

  const inserted = await record.create({
    graph_conversation_id: conversation.graph_conversation_id,
    subject: conversation.subject,
    requester_email_hash: conversation.requester_email_hash,
    requester_name: conversation.requester_name,
    sender_label: ownSide,
    first_message_at: conversation.message_at,
    last_message_at: conversation.message_at
  });
  counts.ticketsCreated += 1;

  // THE TICKET IS CREATED FIRST AND LINKED SECOND, never merged away. A wrong
  // merge cannot be undone; a wrong link is a column somebody clears. The
  // message is stored on its own ticket either way, so nothing is lost if the
  // detection is wrong — what the link changes is that the drafting queue skips
  // it, which is the harm being prevented: one customer, two replies.
  //
  // AFTER creation because the rules compare against OTHER tickets, and running
  // before would leave the new one invisible to a later arrival in the same
  // batch.
  if (detectDuplicate && item.message?.direction === 'inbound') {
    try {
      const hit = await detectDuplicate(item);
      if (hit?.ticketId && hit.ticketId !== inserted.id) {
        await record.linkDuplicate(inserted.id, {
          ofTicketId: hit.ticketId,
          reason: hit.reason
        });
        counts.duplicatesLinked += 1;
        logger?.info?.('ingest.duplicate_linked', {
          ticketId: inserted.id,
          duplicateOf: hit.ticketId,
          reason: hit.reason
        });
      }
    } catch (error) {
      // A missed link costs a second reply somebody has to notice. A failed
      // ingestion loses the email. The first is recoverable and the second is
      // not, so this never throws.
      logger?.warn?.('ingest.duplicate_check_failed', {
        ticketId: inserted.id,
        reason: error.message
      });
    }
  }

  return inserted.id;
}

/**
 * The subset of this page's messages we already hold, or an empty set.
 *
 * NEVER FATAL, and the direction of the failure is chosen. If this read fails
 * the set is empty, every message reads as new, and the writer behaves exactly
 * as it did before the guard existed: a re-sync may re-flag and reopen. The
 * alternative — treating an unknown as "already held" — would silently DROP the
 * reopen for a real customer reply, stranding a live ticket in `closed`. One
 * failure mode is noisy and recoverable; the other is silent and loses work.
 */
async function readKnownMessageIds(store, shopId, mapped, logger) {
  if (typeof store?.knownMessageIds !== 'function') {
    return new Set();
  }
  const ids = mapped
    .filter((item) => !item.removed)
    .map((item) => item.graphMessageId ?? item.message?.graph_message_id)
    .filter(Boolean);
  if (ids.length === 0) {
    return new Set();
  }
  try {
    return await store.knownMessageIds(shopId, ids);
  } catch (error) {
    logger?.warn?.('ingest.known_message_lookup_failed', { message: error.message });
    return new Set();
  }
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

/**
 * The message store: `ticket_messages`, and nothing else.
 *
 * The three ticket methods that used to sit beside this one —
 * `findTicketByConversation`, `insertTicket`, `updateTicket` — are the shared
 * ticket record's (`findByConversation`, `create`, `recordMessageArrival`).
 * What stayed is the upsert, which is the only write to this table anywhere in
 * the codebase and the reason the ticket record reads it but never writes it.
 */
export function createSupabaseMessageStore(supabase) {
  return {
    /**
     * Which of these Graph message ids this shop already stores.
     *
     * The reads are chunked because the filter goes into a URL: PostgREST takes
     * `in.(...)` as a query parameter, and a delta page of Graph ids — which run
     * to ~150 characters each — would otherwise build a URL long enough for the
     * server to reject. One request per KNOWN_ID_CHUNK ids, not one per message.
     */
    async knownMessageIds(shopId, graphMessageIds) {
      const known = new Set();
      const ids = [...new Set(graphMessageIds.filter(Boolean))];
      for (let i = 0; i < ids.length; i += KNOWN_ID_CHUNK) {
        const chunk = ids.slice(i, i + KNOWN_ID_CHUNK);
        const rows = await supabaseSelectAll(
          supabase,
          T.TICKET_MESSAGES,
          {
            shop_id: shopId,
            graph_message_id: {
              operator: 'in',
              value: `(${chunk.map((id) => `"${id}"`).join(',')})`
            }
          },
          'graph_message_id'
        );
        for (const row of rows) {
          known.add(row.graph_message_id);
        }
      }
      return known;
    },

    async upsertMessage(row) {
      // `(shop_id, graph_message_id)` is the idempotency key: re-ingesting a
      // delta page rewrites the row rather than adding a second.
      await supabaseUpsert(supabase, T.TICKET_MESSAGES, [row], 'shop_id,graph_message_id');
    }
  };
}

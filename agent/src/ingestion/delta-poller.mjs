import { supabaseSelect, supabaseUpdateById } from '../../../scripts/lib/supabase-rest-client.mjs';

import { mapGraphMessage } from './graph-message-mapper.mjs';
import { writeIngestedMessages } from './ticket-writer.mjs';
import { allowAllGate } from './spam-gate.mjs';
import { createAuditCollector } from './spam-audit.mjs';

const MAX_PAGES_PER_RUN = 1000; // safety valve against a pathological pagination loop

// One delta reconciliation pass: follow @odata.nextLink pages from the stored
// cursor to the terminating @odata.deltaLink, writing tickets/messages as we go,
// then persist the new deltaLink so the next run resumes exactly here. This is the
// source-of-truth ingestion engine; a future subscription would just trigger it.
//
// The deterministic spam gate runs *before* writing, so blocklisted senders are
// dropped and never stored. recordSpamHits (optional) persists per-rule block counts.
// auditStore (optional) persists one spam_audit row per gate decision — the only
// record a dropped email leaves, since it never reaches tickets/ticket_messages.
export async function runDeltaPoll({
  graphClient,
  store,
  record,
  cursorStore,
  shopId,
  logger,
  // The support address itself, so a message the mailbox sent is recorded as
  // outbound rather than as customer mail (see graph-message-mapper).
  mailbox,
  spamGate = allowAllGate,
  recordSpamHits,
  auditStore,
  triage,
  // Best-effort per-message embedding; a null result stores the message without
  // a vector and the reconciler fills it in later.
  embedMessage,
  // Deterministic duplicate detection. Optional: without it the poll behaves
  // exactly as it did before, and no ticket is ever linked.
  detectDuplicate,
  limit
}) {
  const totals = {
    ticketsCreated: 0,
    messagesIngested: 0,
    messagesEmbedded: 0,
    removed: 0,
    spamBlocked: 0,
    llmSpamFiltered: 0,
    spamAudited: 0,
    attachmentsFetched: 0,
    pages: 0,
    duplicatesLinked: 0
  };
  const hitCounts = new Map();
  // Decisions from both passes buffer here and are written once per poll; the
  // ticket writer records the LLM verdicts into the same collector.
  const audit = createAuditCollector();

  async function flush() {
    if (recordSpamHits && hitCounts.size > 0) {
      await recordSpamHits(hitCounts);
    }
    if (auditStore && audit.size > 0) {
      try {
        totals.spamAudited = await auditStore.flush(shopId, audit.entries());
      } catch (error) {
        // Best-effort: losing an audit row must never fail ingestion or, worse,
        // make a poll retry and re-drop mail. Surfaced in the logs instead.
        logger?.warn?.('ingest.spam_audit_failed', { shopId, message: error.message });
      }
    }
  }

  // Gate, fetch attachment metadata and write one batch of raw Graph messages.
  async function processBatch(messages) {
    const kept = [];
    for (const message of messages) {
      const item = mapGraphMessage(message, { mailbox });
      // Our own replies skip the gate entirely: the blocklist matches on sender,
      // and blocking the support address would drop every reply the team sent.
      if (!item.removed && item.message?.direction === 'inbound') {
        const verdict = spamGate.check(item);
        if (verdict.spam) {
          totals.spamBlocked += 1;
          if (verdict.ruleId) {
            hitCounts.set(verdict.ruleId, (hitCounts.get(verdict.ruleId) || 0) + 1);
          }
          audit.record({
            graphMessageId: item.graphMessageId,
            conversationId: item.conversationId,
            fromEmail: item.message?.from_email,
            subject: item.message?.subject,
            // The cleaned body, kept because a subject line cannot tell a
            // newsletter from a customer whose parcel is lost — and this row is
            // the only thing a reviewer will ever have. Bounded life: see
            // spam-audit.mjs and 04_support.sql.
            bodyText: item.message?.body_text,
            outcome: 'blocked',
            decidedBy: 'blocklist',
            reason: verdict.reason,
            ruleId: verdict.ruleId
          });
          continue; // spam is dropped here — never written to the database
        }
      }
      kept.push(item);
    }

    totals.attachmentsFetched += await fetchAttachmentMetadata(graphClient, kept, logger);

    const counts = await writeIngestedMessages(store, record, shopId, kept, {
      triage,
      audit,
      embedMessage,
      detectDuplicate,
      logger
    });
    totals.ticketsCreated += counts.ticketsCreated;
    totals.messagesIngested += counts.messagesIngested;
    totals.messagesEmbedded += counts.messagesEmbedded;
    totals.removed += counts.removed;
    totals.llmSpamFiltered += counts.llmSpamFiltered;
    totals.duplicatesLinked += counts.duplicatesLinked ?? 0;
  }

  let url = await cursorStore.getDeltaLink(shopId);

  if (limit) {
    return runLimited();
  }

  for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
    const { messages, nextLink, deltaLink } = await graphClient.getDeltaPage(url);
    totals.pages += 1;

    await processBatch(messages);

    if (deltaLink) {
      await cursorStore.setDeltaLink(shopId, deltaLink);
      await flush();
      return totals;
    }
    if (!nextLink) {
      // No deltaLink and no nextLink: nothing more to page. Leave the cursor as-is.
      logger?.warn?.('ingest.delta_page_without_links', { shopId });
      await flush();
      return totals;
    }
    url = nextLink;
  }

  throw new Error(`Delta poll exceeded ${MAX_PAGES_PER_RUN} pages; aborting to avoid a loop.`);

  // UNDER --limit: COLLECT THE NEWEST N, THEN WRITE THEM OLDEST FIRST.
  //
  // The read is newest-first (graph-client.mjs), which is what makes the N the
  // latest N. But every ingestion rule that fires "on the message that creates a
  // ticket" — the sender label, the requester, the duplicate link — assumes
  // that message opened the thread. Written newest-first, a thread's ticket was
  // created from its latest message instead: measured on the 2026-09-14
  // re-ingestion of 400 messages, 15 staff threads went unlabelled, 7 tickets
  // took a colleague as requester (2 then linked to the wrong customer), and 4
  // duplicates and 5 related links were missed. Buffering is affordable here
  // because the limit bounds it; an unlimited read keeps writing page by page.
  async function runLimited() {
    const collected = [];
    let deltaLink = null;
    let limitReached = false;

    for (let page = 0; ; page += 1) {
      if (page >= MAX_PAGES_PER_RUN) {
        throw new Error(`Delta poll exceeded ${MAX_PAGES_PER_RUN} pages; aborting to avoid a loop.`);
      }
      const result = await graphClient.getDeltaPage(url, page === 0 ? { top: limit } : undefined);
      totals.pages += 1;
      collected.push(...result.messages.slice(0, limit - collected.length));

      if (collected.length >= limit) {
        limitReached = true;
        break;
      }
      if (result.deltaLink) {
        deltaLink = result.deltaLink;
        break;
      }
      if (!result.nextLink) {
        logger?.warn?.('ingest.delta_page_without_links', { shopId });
        break;
      }
      url = result.nextLink;
    }

    await processBatch(oldestFirst(collected));

    if (limitReached) {
      // Hit the run budget mid-inbox: stop without advancing the cursor so this
      // stays a repeatable partial test rather than a committed sync position.
      totals.limitReached = true;
    } else if (deltaLink) {
      await cursorStore.setDeltaLink(shopId, deltaLink);
    }
    await flush();
    return totals;
  }
}

/**
 * Raw Graph messages sorted by when they arrived, oldest first.
 *
 * Stable, and undated entries (a delta `@removed` tombstone carries no dates)
 * go last in their original order: they create no ticket, so where they fall
 * cannot change which message opened a thread.
 */
export function oldestFirst(messages) {
  const dateOf = (message) => message?.receivedDateTime ?? message?.sentDateTime ?? null;
  return messages
    .map((message, index) => ({ message, index, at: dateOf(message) }))
    .sort((a, b) => {
      if (a.at && b.at && a.at !== b.at) return a.at < b.at ? -1 : 1;
      if (a.at && !b.at) return -1;
      if (!a.at && b.at) return 1;
      return a.index - b.index;
    })
    .map((entry) => entry.message);
}

/**
 * Fills `attachments` on every kept message, in place.
 *
 * IT ASKS ABOUT EVERY MESSAGE, NOT ONLY THE FLAGGED ONES, and that is the whole
 * point of the function. `hasAttachments` is false for a message whose only
 * attachments are inline: Gmail embeds a pasted photo in the HTML body with a
 * content-id rather than as a separate MIME part, and Exchange does not count
 * those. Measured 2026-09-20 on ticket d48f1c08, where the customer wrote « les
 * adjunto foto de la caja y del contenido » and Graph holds a 3.6 MB inline PNG
 * on a message whose flag reads false. Gating the fetch on the flag left that
 * row at `attachments: null` for two months, and the photo check reported it as
 * « aucune photo » — the one reading the null exists to prevent.
 *
 * THE FLAG IS STILL STORED, because `has_attachments` is what Graph said and
 * the column records that. It is simply not evidence of absence, so nothing
 * decides whether to look based on it.
 *
 * RUNS AFTER THE BLOCKLIST GATE, deliberately. This is one extra Graph request
 * per kept message, and blocked mail is dropped before it — a newsletter with a
 * banner image should not cost a round trip on its way to being discarded.
 *
 * BEST-EFFORT, LIKE THE AUDIT FLUSH. A ticket whose attachment metadata could
 * not be fetched is still a ticket, and failing the poll would re-drive the
 * whole page. The row keeps `attachments: null`, which is the true statement —
 * we did not learn what was attached — and the photo check reports that as
 * unknown rather than as "no photo".
 *
 * A mailbox-id mismatch is the one thing worth shouting about: it fails every
 * row for the same configuration reason, so it is logged once per message with
 * its own event rather than buried as a generic warning.
 */
async function fetchAttachmentMetadata(graphClient, items, logger) {
  if (typeof graphClient?.getAttachmentMetadata !== 'function') {
    return 0;
  }

  let fetched = 0;
  for (const item of items) {
    if (item?.removed || !item.graphMessageId) {
      continue;
    }
    try {
      const attachments = await graphClient.getAttachmentMetadata(item.graphMessageId);
      // null means the mailbox no longer holds the message. Leave the column
      // null too: both mean "not learned", and inventing `[]` would claim we
      // looked and found nothing attached to a mail that says it has something.
      if (attachments) {
        item.message.attachments = attachments;
        fetched += 1;
      }
    } catch (error) {
      logger?.warn?.(
        error.mailboxMismatch ? 'ingest.attachments_mailbox_mismatch' : 'ingest.attachments_failed',
        { graphMessageId: item.graphMessageId, message: error.message }
      );
    }
  }
  return fetched;
}

// Delta cursor persisted in shops.sync_cursors.mail_ingest_delta_link, reusing the
// existing per-shop sync-cursor column. Merge-on-write so other cursors are preserved.
export function createSupabaseCursorStore(supabase) {
  const CURSOR_KEY = 'mail_ingest_delta_link';

  return {
    async getDeltaLink(shopId) {
      const rows = await supabaseSelect(supabase, 'shops', { id: shopId }, 'id,sync_cursors');
      return rows[0]?.sync_cursors?.[CURSOR_KEY] || null;
    },

    async setDeltaLink(shopId, deltaLink) {
      const rows = await supabaseSelect(supabase, 'shops', { id: shopId }, 'id,sync_cursors');
      const current = rows[0]?.sync_cursors || {};
      await supabaseUpdateById(supabase, 'shops', shopId, {
        sync_cursors: { ...current, [CURSOR_KEY]: deltaLink }
      });
    }
  };
}

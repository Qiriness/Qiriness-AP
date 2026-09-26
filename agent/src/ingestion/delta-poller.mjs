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
  // Handed straight to the writer. UNTIL 2026-09-26 THESE TWO WERE DROPPED
  // HERE: the worker passed them and this function never named them, so no
  // ticket got a sender label at creation, no related link was ever made live,
  // and a staff reply was never re-filed. Measured that day: 0 labels and 0
  // links on the 347 tickets the first full read created. The writer's own
  // tests call it directly, which is why nothing failed.
  senderLabel,
  detectRelated,
  // Who may become a ticket's requester in place of one of our own addresses
  // (ticket-writer `threadIdentity`).
  isCandidate,
  // message → actor, stamped on each stored message (casework/actors.mjs).
  actorFor,
  // `inbox` or `sentitems`. Sent Items mail is ours by definition, and may only
  // join a thread that already has a ticket: outbound mail adds to a case, it
  // never opens one (codex_plans/Case_State_Plan.md, stage 2).
  folder = 'inbox',
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
    duplicatesLinked: 0,
    relatedLinked: 0,
    skippedNoTicket: 0,
    skippedCopies: 0,
    requestersCorrected: 0,
    openersCorrected: 0,
    directionsCorrected: 0
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
      const item = mapGraphMessage(message, { mailbox, direction: folder === 'sentitems' ? 'outbound' : undefined });
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
      detectRelated,
      senderLabel,
      isCandidate,
      mailbox,
      actorFor,
      attachOnly: folder === 'sentitems',
      logger
    });
    totals.ticketsCreated += counts.ticketsCreated;
    totals.messagesIngested += counts.messagesIngested;
    totals.messagesEmbedded += counts.messagesEmbedded;
    totals.removed += counts.removed;
    totals.llmSpamFiltered += counts.llmSpamFiltered;
    totals.duplicatesLinked += counts.duplicatesLinked ?? 0;
    totals.relatedLinked += counts.relatedLinked ?? 0;
    totals.skippedNoTicket += counts.skippedNoTicket ?? 0;
    totals.skippedCopies += counts.skippedCopies ?? 0;
    totals.requestersCorrected += counts.requestersCorrected ?? 0;
    totals.openersCorrected += counts.openersCorrected ?? 0;
    totals.directionsCorrected += counts.directionsCorrected ?? 0;
  }

  // Read once per poll, not once per process: `ids:translate` flips the id type
  // under a running worker, and the next poll must follow it.
  const cursor = await cursorStore.load(shopId, folder);
  const immutableIds = cursor.idType === 'immutable';
  let url = cursor.resumeLink || cursor.deltaLink || null;
  let savedLink = url ? (cursor.resumeLink ? 'resume' : 'delta') : null;

  // A SAVED LINK GRAPH REFUSES IS DROPPED, AND THE READ STARTS OVER, once.
  // Starting over is safe: mail already stored does not retrigger its ticket
  // (DECISIONS.md § "Re-delivery is not arrival"). Only the first request of a
  // poll can hit this; a nextLink Graph just handed us failing is a real error.
  async function firstPage(options) {
    try {
      return await graphClient.getDeltaPage(url, { ...options, folder });
    } catch (error) {
      if (!savedLink || !error.linkRejected) throw error;
      logger?.warn?.('ingest.cursor_expired', { shopId, folder, link: savedLink, status: error.status, code: error.code });
      await cursorStore.clearLinks(shopId, folder);
      url = null;
      savedLink = null;
      return graphClient.getDeltaPage(null, { ...options, folder });
    }
  }

  if (limit) {
    return runLimited();
  }

  // PROGRESS IS SAVED PAGE BY PAGE. Until 2026-09-26 only the final deltaLink
  // was saved, so a first full read that died anywhere in its ~280 pages
  // started again from nothing, and no cursor had ever been saved. The nextLink
  // is stored only after its page is written: resuming re-reads nothing that
  // was not stored, and replaying a page that was is harmless.
  for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
    const { messages, nextLink, deltaLink } =
      page === 0 ? await firstPage({ immutableIds }) : await graphClient.getDeltaPage(url, { immutableIds, folder });
    totals.pages += 1;

    await processBatch(messages);

    if (deltaLink) {
      await cursorStore.saveDeltaLink(shopId, deltaLink, folder);
      await flush();
      return totals;
    }
    if (!nextLink) {
      // No deltaLink and no nextLink: nothing more to page. Leave the cursor as-is.
      logger?.warn?.('ingest.delta_page_without_links', { shopId });
      await flush();
      return totals;
    }
    await cursorStore.saveResumeLink(shopId, nextLink, folder);
    url = nextLink;
  }

  // The safety valve still stops the run, but no longer loses it: the resume
  // link is saved, so the next poll carries on from here.
  logger?.warn?.('ingest.page_budget_reached', { shopId, pages: MAX_PAGES_PER_RUN });
  totals.incomplete = true;
  await flush();
  return totals;

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
      const result =
        page === 0 ? await firstPage({ top: limit, immutableIds }) : await graphClient.getDeltaPage(url, { immutableIds, folder });
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
      await cursorStore.saveDeltaLink(shopId, deltaLink, folder);
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

// The keys this poller owns in `shops.sync_cursors`. Merge-on-write, so a key
// this code does not name is never touched.
export const CURSOR_KEYS = {
  // Where the last complete Inbox read ended. Its presence means a full read
  // finished.
  deltaLink: 'mail_ingest_delta_link',
  // The nextLink of the last Inbox page fully written, while a read is under way.
  resumeLink: 'mail_ingest_resume_link',
  // The same pair for Sent Items (stage 2, 2026-09-26).
  sentDeltaLink: 'mail_sent_delta_link',
  sentResumeLink: 'mail_sent_resume_link',
  // When the first INBOX deltaLink was committed. Written once, never
  // overwritten or cleared, and never by Sent Items, which holds only our mail: mail received after it is genuinely new to the pipeline, which
  // is what makes a ticket eligible for automatic drafting
  // (codex_plans/Case_State_Plan.md, stage 6).
  cutoverAt: 'mail_ingest_cutover_at',
  // 'immutable' once `ids:translate` has rewritten the stored ids. Absent means
  // REST ids, the format everything stored before 2026-09-26 is in.
  idType: 'mail_id_type'
};

/** Which two keys hold a folder's position. */
export function linkKeys(folder = 'inbox') {
  return folder === 'sentitems'
    ? { deltaLink: CURSOR_KEYS.sentDeltaLink, resumeLink: CURSOR_KEYS.sentResumeLink }
    : { deltaLink: CURSOR_KEYS.deltaLink, resumeLink: CURSOR_KEYS.resumeLink };
}

/**
 * The next cursor state after a complete read. Pure, so the "cutover is
 * written once" rule is tested without a database.
 */
export function withDeltaLink(current, deltaLink, now = new Date(), folder = 'inbox') {
  const keys = linkKeys(folder);
  const next = { ...current, [keys.deltaLink]: deltaLink };
  delete next[keys.resumeLink];
  if (folder === 'inbox' && !next[CURSOR_KEYS.cutoverAt]) {
    next[CURSOR_KEYS.cutoverAt] = now.toISOString();
  }
  return next;
}

/**
 * The cursor state with links dropped; the cutover and id type stay. One
 * folder's pair, or with no folder every folder's (`ingest:reset`,
 * `ids:translate`).
 */
export function withoutLinks(current, folder = null) {
  const next = { ...current };
  const folders = folder ? [folder] : ['inbox', 'sentitems'];
  for (const f of folders) {
    const keys = linkKeys(f);
    delete next[keys.deltaLink];
    delete next[keys.resumeLink];
  }
  return next;
}

export function createSupabaseCursorStore(supabase) {
  async function read(shopId) {
    const rows = await supabaseSelect(supabase, 'shops', { id: shopId }, 'id,sync_cursors');
    return rows[0]?.sync_cursors || {};
  }

  async function write(shopId, cursors) {
    await supabaseUpdateById(supabase, 'shops', shopId, { sync_cursors: cursors });
  }

  return {
    async load(shopId, folder = 'inbox') {
      const cursors = await read(shopId);
      const keys = linkKeys(folder);
      return {
        deltaLink: cursors[keys.deltaLink] || null,
        resumeLink: cursors[keys.resumeLink] || null,
        idType: cursors[CURSOR_KEYS.idType] || 'rest'
      };
    },

    async saveResumeLink(shopId, resumeLink, folder = 'inbox') {
      const current = await read(shopId);
      await write(shopId, { ...current, [linkKeys(folder).resumeLink]: resumeLink });
    },

    async saveDeltaLink(shopId, deltaLink, folder = 'inbox') {
      await write(shopId, withDeltaLink(await read(shopId), deltaLink, new Date(), folder));
    },

    async clearLinks(shopId, folder = 'inbox') {
      await write(shopId, withoutLinks(await read(shopId), folder));
    }
  };
}

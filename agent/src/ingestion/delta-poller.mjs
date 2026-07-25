import { supabaseSelect, supabaseUpdateById } from '../../../scripts/lib/supabase-rest-client.mjs';

import { mapGraphMessage } from './graph-message-mapper.mjs';
import { writeIngestedMessages } from './ticket-writer.mjs';
import { allowAllGate } from './spam-gate.mjs';

const MAX_PAGES_PER_RUN = 1000; // safety valve against a pathological pagination loop

// One delta reconciliation pass: follow @odata.nextLink pages from the stored
// cursor to the terminating @odata.deltaLink, writing tickets/messages as we go,
// then persist the new deltaLink so the next run resumes exactly here. This is the
// source-of-truth ingestion engine; a future subscription would just trigger it.
//
// The deterministic spam gate runs *before* writing, so blocklisted senders are
// dropped and never stored. recordSpamHits (optional) persists per-rule block counts.
export async function runDeltaPoll({
  graphClient,
  store,
  cursorStore,
  shopId,
  logger,
  spamGate = allowAllGate,
  recordSpamHits,
  triage,
  limit
}) {
  const totals = {
    ticketsCreated: 0,
    messagesIngested: 0,
    removed: 0,
    spamBlocked: 0,
    llmSpamFiltered: 0,
    pages: 0
  };
  const hitCounts = new Map();
  let processed = 0; // emails pulled from Graph and considered this run

  async function flushHits() {
    if (recordSpamHits && hitCounts.size > 0) {
      await recordSpamHits(hitCounts);
    }
  }

  let url = await cursorStore.getDeltaLink(shopId);
  for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
    const { messages, nextLink, deltaLink } = await graphClient.getDeltaPage(
      url,
      page === 0 && limit ? { top: limit } : undefined
    );
    totals.pages += 1;

    // Under --limit, only consider up to the remaining budget from this page.
    const pageMessages = limit ? messages.slice(0, limit - processed) : messages;
    processed += pageMessages.length;

    const kept = [];
    for (const message of pageMessages) {
      const item = mapGraphMessage(message);
      if (!item.removed) {
        const verdict = spamGate.check(item);
        if (verdict.spam) {
          totals.spamBlocked += 1;
          if (verdict.ruleId) {
            hitCounts.set(verdict.ruleId, (hitCounts.get(verdict.ruleId) || 0) + 1);
          }
          continue; // spam is dropped here — never written to the database
        }
      }
      kept.push(item);
    }

    const counts = await writeIngestedMessages(store, shopId, kept, { triage });
    totals.ticketsCreated += counts.ticketsCreated;
    totals.messagesIngested += counts.messagesIngested;
    totals.removed += counts.removed;
    totals.llmSpamFiltered += counts.llmSpamFiltered;

    if (limit && processed >= limit) {
      // Hit the run budget mid-inbox: stop without advancing the cursor so this
      // stays a repeatable partial test rather than a committed sync position.
      totals.limitReached = true;
      await flushHits();
      return totals;
    }

    if (deltaLink) {
      await cursorStore.setDeltaLink(shopId, deltaLink);
      await flushHits();
      return totals;
    }
    if (!nextLink) {
      // No deltaLink and no nextLink: nothing more to page. Leave the cursor as-is.
      logger?.warn?.('ingest.delta_page_without_links', { shopId });
      await flushHits();
      return totals;
    }
    url = nextLink;
  }

  throw new Error(`Delta poll exceeded ${MAX_PAGES_PER_RUN} pages; aborting to avoid a loop.`);
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

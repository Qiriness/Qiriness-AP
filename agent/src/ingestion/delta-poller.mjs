import { supabaseSelect, supabaseUpdateById } from '../../../scripts/lib/supabase-rest-client.mjs';

import { mapGraphMessage } from './graph-message-mapper.mjs';
import { writeIngestedMessages } from './ticket-writer.mjs';

const MAX_PAGES_PER_RUN = 1000; // safety valve against a pathological pagination loop

// One delta reconciliation pass: follow @odata.nextLink pages from the stored
// cursor to the terminating @odata.deltaLink, writing tickets/messages as we go,
// then persist the new deltaLink so the next run resumes exactly here. This is the
// source-of-truth ingestion engine; a future subscription would just trigger it.
export async function runDeltaPoll({ graphClient, store, cursorStore, shopId, logger }) {
  const totals = { ticketsCreated: 0, messagesIngested: 0, removed: 0, pages: 0 };

  let url = await cursorStore.getDeltaLink(shopId);
  for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
    const { messages, nextLink, deltaLink } = await graphClient.getDeltaPage(url);
    totals.pages += 1;

    const mapped = messages.map((message) => mapGraphMessage(message));
    const counts = await writeIngestedMessages(store, shopId, mapped);
    totals.ticketsCreated += counts.ticketsCreated;
    totals.messagesIngested += counts.messagesIngested;
    totals.removed += counts.removed;

    if (deltaLink) {
      await cursorStore.setDeltaLink(shopId, deltaLink);
      return totals;
    }
    if (!nextLink) {
      // No deltaLink and no nextLink: nothing more to page. Leave the cursor as-is.
      logger?.warn?.('ingest.delta_page_without_links', { shopId });
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

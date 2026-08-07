import { supabaseSelect, supabaseUpdateById } from '../../../scripts/lib/supabase-rest-client.mjs';

import { mapGraphMessage } from './graph-message-mapper.mjs';
import { buildBodyPatch, DEFAULT_BODY_RETENTION_DAYS } from './spam-audit.mjs';

// Fills in the bodies of spam_audit rows written before 08_spam_audit_body.sql.
//
// Ingestion stores the body from now on; these are the rows that already exist,
// and their only handle back to the email is `graph_message_id`. The worker
// never deletes or moves mail — it holds Mail.Read plus the one forward action —
// so a blocked email is usually still sitting in the Inbox and can be re-read.
//
// USUALLY, NOT ALWAYS, and the gap is the point of the `gone` count. The mailbox
// is shared with humans who delete and file things, so some ids no longer
// resolve. That is a permanent answer for those rows: the decision record is all
// there will ever be, and the dashboard already renders that state.
//
// DELIBERATELY BATCHED AND NEWEST FIRST. Every row costs a Graph call, and a
// recent decision is the one somebody might still want to overturn — a block
// from seven months ago is history. Run it with a small limit first and confirm
// the bodies look right before widening.

/**
 * @param store       { listRowsMissingBody, saveBody }
 * @param graphClient anything exposing getMessage(id) -> raw message | null
 */
export async function runSpamBodyBackfill({
  store,
  graphClient,
  shopId,
  mailbox,
  limit = 5,
  retentionDays = DEFAULT_BODY_RETENTION_DAYS,
  dryRun = false,
  logger,
  onPreview
} = {}) {
  const totals = { considered: 0, filled: 0, gone: 0, empty: 0, failed: 0, mailboxMismatch: false };

  const rows = await store.listRowsMissingBody(shopId, limit);
  totals.considered = rows.length;

  for (const row of rows) {
    try {
      const raw = await graphClient.getMessage(row.graph_message_id);
      if (!raw) {
        // Deleted or filed out of the Inbox since the decision. Nothing to
        // retry — a later run would ask Graph the same question again.
        totals.gone += 1;
        onPreview?.({ row, outcome: 'gone' });
        continue;
      }

      // Through the SAME mapper ingestion uses, not a bespoke read of raw.body:
      // it is what strips the HTML and what replaces a contact-form wrapper with
      // the customer's own text. A backfilled body that differed in shape from
      // an ingested one would make the two eras of this column incomparable.
      const item = mapGraphMessage(raw, { mailbox });
      const patch = buildBodyPatch(item.message?.body_text, { retentionDays });

      if (!patch.body_text) {
        totals.empty += 1;
        onPreview?.({ row, outcome: 'empty' });
        continue;
      }

      if (!dryRun) {
        await store.saveBody(row.id, patch);
      }
      totals.filled += 1;
      onPreview?.({ row, outcome: 'filled', body: patch.body_text });
    } catch (error) {
      // A mailbox mismatch is not a per-row failure — every id in the table is
      // equally invalid, so continuing would make hundreds of pointless Graph
      // calls and report a data problem the operator cannot fix. Stop and say
      // what is actually wrong.
      if (error.mailboxMismatch) {
        totals.mailboxMismatch = true;
        logger?.error?.('spam_audit.backfill_mailbox_mismatch', { shopId, message: error.message });
        onPreview?.({ row, outcome: 'mismatch', error: error.message });
        break;
      }

      // One unreadable message never ends the run: the rest of the batch is
      // still worth filling, and the failure is visible in the totals.
      totals.failed += 1;
      logger?.warn?.('spam_audit.backfill_failed', {
        shopId,
        graphMessageId: row.graph_message_id,
        message: error.message
      });
      onPreview?.({ row, outcome: 'failed', error: error.message });
    }
  }

  return totals;
}

export function createSpamBodyBackfillStore(supabase) {
  return {
    /**
     * Blocked decisions that have never had a body captured, newest first.
     *
     * `body_captured_at is null` rather than `body_text is null`: a row whose
     * body was captured and has since expired must NOT be re-fetched, or the
     * backfill would quietly undo the retention purge every time it ran.
     */
    async listRowsMissingBody(shopId, limit) {
      return supabaseSelect(
        supabase,
        'spam_audit',
        {
          shop_id: shopId,
          outcome: 'blocked',
          body_captured_at: { operator: 'is', value: null }
        },
        'id,graph_message_id,subject,from_email,decided_at',
        { order: 'decided_at.desc', limit }
      );
    },

    async saveBody(id, patch) {
      await supabaseUpdateById(supabase, 'spam_audit', id, patch);
    }
  };
}

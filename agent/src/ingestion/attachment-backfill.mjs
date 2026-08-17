import { supabaseSelect, supabaseUpdateById } from '../../../scripts/lib/supabase-rest-client.mjs';

import { classifyAttachments } from '../investigation/photo-evidence.mjs';

// Fills `ticket_messages.attachments` for rows ingested before the column
// existed, by asking Graph what was attached.
//
// WHY THERE IS ANYTHING TO BACKFILL. Ingestion now fetches attachment metadata
// for every kept message that reports one, but the stored corpus predates that:
// 38 of 296 inbound messages carry `has_attachments = true` and no metadata at
// all. Those are exactly the messages a damage claim would need, and until this
// runs the photo check answers `attachment_type_unknown` for every one of them —
// honest, and useless.
//
// IT SELECTS ON `attachments is null`, NOT ON A DATE. Null means "never
// fetched", which is the real condition; a cutoff timestamp would be a second,
// weaker way of asking the same question and would silently skip any row a
// failed poll left unfilled.
//
// A MESSAGE THAT HAS LEFT THE MAILBOX STAYS NULL. Graph returns 404, the row
// keeps its null, and the count reports it. Writing `[]` there would be a claim
// that we looked and nothing was attached, about a message whose own flag says
// otherwise.
//
// Metadata only — name, contentType, size, isInline. The bytes never leave
// Microsoft; see `getAttachmentMetadata`.

const DEFAULT_LIMIT = 25;

export function createAttachmentBackfillStore(supabase) {
  return {
    /** Inbound messages that say they have attachments and have no metadata. */
    async pending(shopId, limit) {
      return supabaseSelect(
        supabase,
        'ticket_messages',
        {
          shop_id: shopId,
          has_attachments: true,
          attachments: { operator: 'is', value: 'null' },
          deleted_at: { operator: 'is', value: 'null' }
        },
        'id,graph_message_id,subject,direction,received_at',
        // Newest first: a recent ticket is the one somebody may still be
        // answering, so it is the one worth filling first if the run is capped.
        { order: 'received_at.desc', limit }
      );
    },

    async save(messageId, attachments) {
      await supabaseUpdateById(supabase, 'ticket_messages', messageId, { attachments });
    }
  };
}

export async function runAttachmentBackfill({
  store,
  graphClient,
  shopId,
  limit = DEFAULT_LIMIT,
  dryRun = false,
  logger = null,
  onPreview = null
} = {}) {
  const totals = {
    considered: 0,
    filled: 0,
    gone: 0,
    failed: 0,
    withImages: 0,
    mailboxMismatch: false
  };

  const rows = await store.pending(shopId, limit);
  totals.considered = rows.length;

  for (const row of rows) {
    let attachments;
    try {
      attachments = await graphClient.getAttachmentMetadata(row.graph_message_id);
    } catch (error) {
      if (error.mailboxMismatch) {
        // Every stored id fails for the same configuration reason, so there is
        // nothing to learn from the remaining rows. Stop rather than log the
        // identical error once per message.
        totals.mailboxMismatch = true;
        logger?.warn?.('attachments.backfill_mailbox_mismatch', { messageId: row.id });
        break;
      }
      totals.failed += 1;
      onPreview?.({ row, outcome: 'failed', error: error.message });
      continue;
    }

    if (!attachments) {
      totals.gone += 1;
      onPreview?.({ row, outcome: 'gone' });
      continue;
    }

    const summary = classifyAttachments(attachments);
    if (summary.images > 0) totals.withImages += 1;

    if (!dryRun) {
      await store.save(row.id, attachments);
    }
    totals.filled += 1;
    onPreview?.({ row, outcome: 'filled', attachments, summary });
  }

  return totals;
}

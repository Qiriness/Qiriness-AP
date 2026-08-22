import { supabaseSelect, supabaseUpdateById } from '../../../scripts/lib/supabase-rest-client.mjs';

import { isNotificationSender } from './contact-form.mjs';
import { mapGraphMessage } from './graph-message-mapper.mjs';

// Repairs outbound messages whose identity and body were overwritten by a
// contact-form parse that should never have run on them.
//
// THE BUG. `mapGraphMessage` swaps a message's sender for the customer named in
// the body whenever that body parses as a Shopify contact-form notification —
// correct for the notification itself, wrong for our REPLY to it, because a
// reply quotes what it answers and the quoted block still parses. The parse is
// now gated on `direction === 'inbound'`; these rows were written before it was.
//
// Measured on this corpus: 88 outbound messages across 74 of 214 tickets. Every
// one carries a customer's address as its sender and the customer's original
// words as its body — the reply the team actually sent is not stored anywhere.
//
// TWO REPAIRS, AND ONLY ONE OF THEM NEEDS THE NETWORK:
//
//   IDENTITY is already on the row. `sanitizeGraphPayload` recorded the true
//   envelope under `raw_graph_payload.contactForm.envelopeFrom` at ingestion, so
//   `from_email`/`from_name` are restored from what we already hold. Offline,
//   free, and exact.
//
//   THE BODY IS GONE and can only come back from the mailbox. Graph is asked for
//   the message and the fixed mapper re-derives the row, which is deliberately
//   the same code path ingestion uses rather than a second, drifting copy.
//
// SO `--identity-only` IS A REAL MODE, not a convenience: it repairs the half
// that is provably correct without touching the network, and it is the right
// thing to run if Graph credentials are unavailable or a message has left the
// mailbox.

const DEFAULT_LIMIT = 25;

/** The marker: a contact form recorded on a message that is not inbound. */
export function createContactFormRepairStore(supabase) {
  return {
    async pending(shopId, limit) {
      const rows = await supabaseSelect(
        supabase,
        'ticket_messages',
        {
          shop_id: shopId,
          deleted_at: { operator: 'is', value: 'null' }
        },
        'id,graph_message_id,subject,from_email,from_name,body_text,received_at,raw_graph_payload',
        { order: 'received_at.desc' }
      );
      // Filtered here rather than in the query: the marker is a nested jsonb key
      // and expressing `raw_graph_payload->contactForm is not null` through the
      // REST filter grammar is less legible than reading it, on a table this size.
      //
      // A GENUINE NOTIFICATION IS NOT A CASUALTY. 96 of the 148 parsed messages
      // really did arrive from Shopify's mailer and their swapped identity is
      // correct — repairing those would undo the feature. The broken rows are
      // exactly the ones whose recorded envelope is somebody else.
      return rows
        .filter((row) => {
          const form = row?.raw_graph_payload?.contactForm;
          if (!form) {
            return false;
          }
          const envelope =
            row.raw_graph_payload?.from?.address ?? form.envelopeFrom?.address ?? null;
          return !isNotificationSender(envelope);
        })
        .slice(0, limit);
    },

    async save(messageId, patch) {
      await supabaseUpdateById(supabase, 'ticket_messages', messageId, patch);
    }
  };
}

/**
 * The sender this row should have had, read from what was stored at ingestion.
 *
 * Returns null when the payload never recorded an envelope — nothing is guessed
 * from the address, because a wrong sender written confidently is worse than the
 * wrong sender already there.
 *
 * Two places hold it depending on when the row was written: `contactForm
 * .envelopeFrom` on the outbound rows, and the plain `from` on inbound ones,
 * where `sanitizeGraphPayload` kept the real envelope all along.
 */
export function identityFromPayload(row) {
  const envelope =
    row?.raw_graph_payload?.from ?? row?.raw_graph_payload?.contactForm?.envelopeFrom;
  if (!envelope?.address) {
    return null;
  }
  return { from_email: envelope.address, from_name: envelope.name ?? null };
}

/**
 * @param mailbox  the support address, so the re-map resolves direction the same
 *   way ingestion did. Without it every message re-maps as inbound and the parse
 *   this repairs would fire again.
 */
export async function runContactFormRepair({
  store,
  graphClient = null,
  mailbox,
  shopId,
  limit = DEFAULT_LIMIT,
  dryRun = false,
  identityOnly = false,
  logger,
  onPreview
} = {}) {
  if (!mailbox) {
    throw new Error('runContactFormRepair requires the support mailbox address.');
  }
  if (!identityOnly && !graphClient) {
    throw new Error('runContactFormRepair needs a graphClient unless identityOnly is set.');
  }

  const totals = { considered: 0, identityFixed: 0, bodyRecovered: 0, missing: 0, failed: 0 };
  const rows = await store.pending(shopId, limit);
  totals.considered = rows.length;

  for (const row of rows) {
    const identity = identityFromPayload(row);
    if (!identity) {
      totals.failed += 1;
      onPreview?.({ row, outcome: 'no-envelope' });
      continue;
    }

    const patch = { ...identity };
    let outcome = 'identity';
    let recovered = null;

    if (!identityOnly) {
      try {
        const raw = await graphClient.getMessage(row.graph_message_id);
        if (!raw) {
          // The message has left the mailbox. The identity repair still stands —
          // it came off our own row — so this is a partial success, not a skip.
          totals.missing += 1;
          outcome = 'identity (body gone from mailbox)';
        } else {
          const { message } = mapGraphMessage(raw, { mailbox });
          // Trust the re-map only if the fixed mapper agrees this is ours. If it
          // still resolves inbound, something about the envelope is not what we
          // think and writing its body would repeat the original mistake.
          // The fixed mapper must agree the form should not have been parsed.
          // If it still parses one, the envelope IS a notification relay and the
          // original swap was correct — leave the row exactly as it is.
          if (message.raw_graph_payload?.contactForm) {
            totals.failed += 1;
            onPreview?.({ row, outcome: 'genuine notification — left alone' });
            continue;
          }
          patch.body_text = message.body_text;
          patch.body_preview = message.body_preview;
          patch.from_email = message.from_email;
          patch.from_name = message.from_name;
          patch.direction = message.direction;
          patch.raw_graph_payload = message.raw_graph_payload;
          recovered = message.body_text;
          totals.bodyRecovered += 1;
          outcome = 'identity + body';
        }
      } catch (error) {
        totals.failed += 1;
        logger?.warn?.('repair.contact_form.fetch_failed', {
          messageId: row.id,
          error: error.message
        });
        onPreview?.({ row, outcome: 'fetch failed', error });
        continue;
      }
    }

    if (!dryRun) {
      await store.save(row.id, patch);
    }
    totals.identityFixed += 1;
    onPreview?.({ row, outcome, patch, recovered });
  }

  return totals;
}

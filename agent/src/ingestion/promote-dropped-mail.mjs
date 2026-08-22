import { hashIdentifier } from '../../../scripts/lib/compliance-audit.mjs';

import { writeIngestedMessages } from './ticket-writer.mjs';

// Turning one dropped email back into a ticket — the "Add as ticket" action on
// the dashboard's Irrelevant section.
//
// WHY THIS CAN EXIST NOW. The original rule was that promoting a dropped email
// meant the agent re-fetching it from Graph, which is unreachable while the
// stored `graph_message_id`s belong to a different mailbox than the configured
// one (DECISIONS.md § A mailbox-id mismatch is a configuration answer). That
// premise stopped being true when `spam_audit` started keeping the cleaned body:
// the row now holds everything `ticket_messages` needs, so the promotion is a
// write from data we already have and needs no mailbox at all.
//
// IT GOES THROUGH `writeIngestedMessages`, and that is the whole point of the
// file. Threading on `conversationId`, idempotency on `(shop_id,
// graph_message_id)`, the first/last message window, `needs_categorisation`,
// reopening a closed thread and backfilling the requester are all ingestion's
// rules; a promoted email is an ingested email that took a detour, so it must
// arrive by the same door or the two paths will drift. All this module owns is
// the shape conversion: one `spam_audit` row -> one mapper-shaped item.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//   - No triage. A person overruling the gate is the decision; asking the gate
//     again would be asking the thing that was just overruled.
//   - No duplicate detection. A hand-promoted email is a deliberate act, and a
//     duplicate link takes the ticket out of the drafting queue — a wrong link
//     here would silently answer nobody.
//   - No spam_audit write. The gate's decision row is the audit trail and stands
//     exactly as it was made; that this email became a ticket afterwards is
//     recorded by the ticket existing (see `listDroppedMail`, which subtracts
//     promoted rows rather than rewriting them).

/** A promotion the data cannot support. Carries `code` so callers can map it. */
export class DroppedMailPromotionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DroppedMailPromotionError';
    this.code = code;
  }
}

/**
 * Why this row can or cannot become a ticket.
 *
 * Split out from the promotion so the dashboard can disable the button for the
 * same reason the write would have refused, rather than offering an action that
 * fails when it is used.
 */
export function promotionBlocker(row) {
  if (!row?.graph_message_id) {
    // The idempotency key of both tables. Without it a second promotion would
    // write a second message rather than rewriting the first.
    return {
      code: 'no_message_id',
      message: 'This decision has no Graph message id, so it cannot be threaded into a ticket.'
    };
  }
  if (row.outcome !== 'blocked') {
    return {
      code: 'not_blocked',
      message: 'This email was kept, so it is already a ticket.'
    };
  }
  if (!textOrNull(row.body_text)) {
    // Captured-and-since-expired and never-captured are one answer here: the
    // agent reads bodies, so a ticket with only a subject line is a ticket
    // every pass downstream would skip.
    return {
      code: 'no_body',
      message:
        'The text of this email is not stored — never captured, or past its retention window — so there is nothing to read into a ticket.'
    };
  }
  return null;
}

/** True when `promotionBlocker` finds nothing in the way. */
export function canPromote(row) {
  return promotionBlocker(row) === null;
}

/**
 * One `spam_audit` row in the shape `mapGraphMessage` produces.
 *
 * The gate ran AFTER the mapper, so the row already holds the mapped values: a
 * contact-form notification was identity-swapped before it was judged, which is
 * why `from_email` is the customer's address and `body_text` the form-stripped
 * message. Nothing is re-parsed here.
 *
 * THE FIELDS THE ENVELOPE CARRIED ARE GONE, and they are left empty rather than
 * guessed: recipients, the reply-chain headers, the body preview, the attachment
 * flag. `attachments` stays null, which already means "never fetched" on this
 * column, so the photo check reads this row as unasked rather than as answered
 * "no attachment".
 *
 * `received_at` IS THE DECISION TIME, NOT THE ARRIVAL TIME. The audit row does
 * not carry when the email arrived, only when the gate ruled — which is within a
 * poll of arrival for live mail, and the day of the import for the backfilled
 * corpus. It drives `first_message_at`, so a promoted historical email enters
 * the queue as recent work. That is the honest reading of it: it is being
 * started now.
 */
export function mapAuditRowToItem(row) {
  const decidedAt = row.decided_at || new Date().toISOString();
  const conversationId = row.graph_conversation_id || row.graph_message_id;
  const fromEmail = textOrNull(row.from_email);
  const subject = textOrNull(row.subject);

  const message = {
    graph_message_id: row.graph_message_id,
    graph_conversation_id: conversationId,
    internet_message_id: null,
    in_reply_to: null,
    reference_ids: [],
    // A dropped email is always one somebody sent us: our own replies skip both
    // gates, so no outbound message can ever have an audit row to promote.
    direction: 'inbound',
    from_email: fromEmail,
    from_name: null,
    to_emails: [],
    cc_emails: [],
    subject,
    body_text: row.body_text,
    body_preview: null,
    attachments: null,
    received_at: decidedAt,
    sent_at: null,
    // Provenance, in the column that already holds where a message came from.
    // Never the body — that is `body_text`'s job, and duplicating it here would
    // put a second copy of the same personal data in a column with no clock.
    raw_graph_payload: {
      promotedFromSpamAudit: {
        spamAuditId: row.id ?? null,
        decidedBy: row.decided_by ?? null,
        label: row.label ?? null,
        reason: row.reason ?? null,
        decidedAt
      }
    }
  };

  const conversation = {
    graph_conversation_id: conversationId,
    subject,
    // Same key ingestion writes: the hash, never the address, and only from an
    // inbound sender.
    requester_email_hash: fromEmail ? hashIdentifier(fromEmail) : null,
    requester_name: null,
    message_at: decidedAt
  };

  return {
    removed: false,
    graphMessageId: row.graph_message_id,
    conversationId,
    message,
    conversation,
    contactForm: null
  };
}

/**
 * Writes one dropped email into the queue and returns the ticket it landed on.
 *
 * Idempotent by construction: the message upsert is keyed on `(shop_id,
 * graph_message_id)` and the ticket on the conversation, so promoting the same
 * row twice rewrites one message onto one ticket. Two of the 49 blocked rows on
 * this corpus belong to a conversation that already has a ticket — the blocklist
 * matches senders, including on a reply into a live thread — so joining an
 * existing ticket is a normal outcome here, not an edge case.
 *
 * `embedMessage` is optional and left unwired by the dashboard: an embedding is
 * best-effort at write time by contract, and `npm run embed:tickets` is the
 * reconciler that fills it in. The alternative is putting an OpenAI client
 * behind a button click.
 *
 * The parameter types are annotated because the dashboard calls this from
 * TypeScript: without them the defaults below are inferred as `null` and a real
 * `senderLabel` is rejected at the call site.
 *
 * @param {{
 *   store: any,
 *   record: any,
 *   shopId: string,
 *   auditRow: any,
 *   senderLabel?: ((fromEmail: string | null) => string | null) | null,
 *   embedMessage?: ((message: any) => Promise<any>) | null,
 *   logger?: any
 * }} args
 */
export async function promoteDroppedMail({
  store,
  record,
  shopId,
  auditRow,
  // Defaulted rather than merely optional, so a TypeScript caller (the
  // dashboard) is not required to pass the two collaborators it deliberately
  // does not have.
  senderLabel = null,
  embedMessage = null,
  logger = null
}) {
  const blocker = promotionBlocker(auditRow);
  if (blocker) {
    throw new DroppedMailPromotionError(blocker.code, blocker.message);
  }

  const item = mapAuditRowToItem(auditRow);
  const counts = await writeIngestedMessages(store, record, shopId, [item], {
    embedMessage,
    senderLabel,
    logger
  });

  // Read back rather than returned by the writer: `writeIngestedMessages`
  // answers with counts, and this is the one caller that needs to say WHICH
  // ticket — the dashboard puts the row on screen.
  const ticket = await record.findByConversation(item.conversationId);
  if (!ticket) {
    throw new DroppedMailPromotionError(
      'not_written',
      'The email was promoted but its ticket could not be read back.'
    );
  }

  logger?.info?.('spam.promoted', {
    shopId,
    ticketId: ticket.id,
    ticketCreated: counts.ticketsCreated === 1,
    decidedBy: auditRow.decided_by ?? null
  });

  return {
    ticketId: ticket.id,
    ticketCreated: counts.ticketsCreated === 1,
    messagesIngested: counts.messagesIngested
  };
}

function textOrNull(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

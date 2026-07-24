import { htmlToText, normalizePlainText } from '../../../scripts/lib/html-to-text.mjs';
import { hashIdentifier } from '../../../scripts/lib/compliance-audit.mjs';

// Pure mapping from a raw Microsoft Graph message to the row fields for
// tickets / ticket_messages. No I/O, so this is the unit-tested core of
// ingestion. The ticket_writer merges the conversation hints and stamps
// ticket_id / shop_id onto the message.

export function mapGraphMessage(raw, { direction = 'inbound' } = {}) {
  // Delta responses include tombstones for removed messages: `{ id, '@removed': {...} }`.
  if (raw && raw['@removed']) {
    return {
      removed: true,
      graphMessageId: raw.id ?? null,
      conversationId: raw.conversationId ?? null
    };
  }

  const fromEmail = raw?.from?.emailAddress?.address || null;
  const fromName = raw?.from?.emailAddress?.name || null;
  const receivedAt = raw?.receivedDateTime || null;
  const sentAt = raw?.sentDateTime || null;
  const messageAt = receivedAt || sentAt || null;
  const conversationId = raw?.conversationId || null;

  const message = {
    graph_message_id: raw?.id || null,
    graph_conversation_id: conversationId,
    internet_message_id: raw?.internetMessageId || null,
    in_reply_to: null,
    direction,
    from_email: fromEmail,
    from_name: fromName,
    to_emails: recipientAddresses(raw?.toRecipients),
    cc_emails: recipientAddresses(raw?.ccRecipients),
    subject: raw?.subject || null,
    body_text: cleanBody(raw?.body),
    body_preview: raw?.bodyPreview ? normalizePlainText(raw.bodyPreview) : null,
    has_attachments: Boolean(raw?.hasAttachments),
    received_at: receivedAt,
    sent_at: sentAt,
    raw_graph_payload: sanitizeGraphPayload(raw)
  };

  const conversation = {
    graph_conversation_id: conversationId,
    subject: raw?.subject || null,
    // Requester identity comes from the inbound sender. Store only the hash on
    // the ticket (raw address stays on the message), matching orders.customer_email_hash.
    requester_email_hash: direction === 'inbound' ? hashIdentifier(fromEmail) : null,
    requester_name: direction === 'inbound' ? fromName : null,
    message_at: messageAt
  };

  return { removed: false, graphMessageId: message.graph_message_id, conversationId, message, conversation };
}

export function cleanBody(body) {
  if (!body || !body.content) {
    return null;
  }
  const text =
    body.contentType && body.contentType.toLowerCase() === 'text'
      ? normalizePlainText(body.content)
      : htmlToText(body.content);
  return text || null;
}

function recipientAddresses(recipients) {
  if (!Array.isArray(recipients)) {
    return [];
  }
  return recipients
    .map((recipient) => recipient?.emailAddress?.address)
    .filter((address) => typeof address === 'string' && address.length > 0);
}

// Traceability metadata only — never the body content (body_text already holds the
// cleaned body) and never attachment binaries. Addresses are kept because they are
// operationally required to reply.
function sanitizeGraphPayload(raw) {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  return {
    id: raw.id ?? null,
    conversationId: raw.conversationId ?? null,
    internetMessageId: raw.internetMessageId ?? null,
    receivedDateTime: raw.receivedDateTime ?? null,
    sentDateTime: raw.sentDateTime ?? null,
    hasAttachments: Boolean(raw.hasAttachments),
    isDraft: Boolean(raw.isDraft),
    from: raw.from?.emailAddress ?? null,
    toRecipients: Array.isArray(raw.toRecipients)
      ? raw.toRecipients.map((r) => r?.emailAddress ?? null)
      : [],
    ccRecipients: Array.isArray(raw.ccRecipients)
      ? raw.ccRecipients.map((r) => r?.emailAddress ?? null)
      : []
  };
}

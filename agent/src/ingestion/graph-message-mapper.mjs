import { htmlToText, normalizePlainText } from '../../../scripts/lib/html-to-text.mjs';
import { hashIdentifier } from '../../../scripts/lib/compliance-audit.mjs';

import { parseContactForm } from './contact-form.mjs';

// Pure mapping from a raw Microsoft Graph message to the row fields for
// tickets / ticket_messages. No I/O, so this is the unit-tested core of
// ingestion. The ticket_writer merges the conversation hints and stamps
// ticket_id / shop_id onto the message.
//
// Two normalisations happen here, both because the Graph envelope does not say
// what the rest of the pipeline needs to know:
//
//   DIRECTION. The poller reads the Inbox, but the Inbox is not only inbound —
//   the team's own replies land back in it (reply-all, or the mailbox on cc).
//   Measured on a real mailbox, 123 of 345 messages were sent BY the support
//   address and were being stored as customer mail, which put OUR reply at the
//   end of 43% of threads — exactly where the categoriser looks for how the
//   customer currently feels. Pass `mailbox` and a message from that address is
//   recorded as outbound.
//
//   IDENTITY. A Shopify contact-form notification is *about* a customer but
//   *from* Shopify, so the envelope identifies the wrong person. When the body
//   parses as a contact form, the customer's own name, address and message
//   replace the envelope's; the original envelope survives in raw_graph_payload.
//   See contact-form.mjs for why this beats letting the model infer them.

export function mapGraphMessage(raw, { direction, mailbox } = {}) {
  // Delta responses include tombstones for removed messages: `{ id, '@removed': {...} }`.
  if (raw && raw['@removed']) {
    return {
      removed: true,
      graphMessageId: raw.id ?? null,
      conversationId: raw.conversationId ?? null
    };
  }

  const envelopeEmail = raw?.from?.emailAddress?.address || null;
  const envelopeName = raw?.from?.emailAddress?.name || null;
  const receivedAt = raw?.receivedDateTime || null;
  const sentAt = raw?.sentDateTime || null;
  const messageAt = receivedAt || sentAt || null;
  const conversationId = raw?.conversationId || null;

  const rawBody = cleanBody(raw?.body);
  // Null when the body is not a recognisable contact-form notification, so an
  // unrecognised or reworded template degrades to the envelope rather than to a
  // wrong customer.
  const form = parseContactForm(rawBody);

  const resolvedDirection = direction || resolveDirection(envelopeEmail, mailbox);
  // Our own replies are never *about* a requester, and a contact-form
  // notification is about the person named in the body, not about Shopify.
  const fromEmail = form?.email || envelopeEmail;
  const fromName = form?.name || envelopeName;
  const isInbound = resolvedDirection === 'inbound';

  const message = {
    graph_message_id: raw?.id || null,
    graph_conversation_id: conversationId,
    internet_message_id: raw?.internetMessageId || null,
    in_reply_to: null,
    direction: resolvedDirection,
    from_email: fromEmail,
    from_name: fromName,
    to_emails: recipientAddresses(raw?.toRecipients),
    cc_emails: recipientAddresses(raw?.ccRecipients),
    subject: raw?.subject || null,
    // What the customer actually wrote. The wrapper and its labelled fields are
    // stripped: they cost prompt tokens on every categorisation and drafting
    // call, and restate as prose what the columns now hold as data.
    body_text: form?.body || rawBody,
    body_preview: raw?.bodyPreview ? normalizePlainText(raw.bodyPreview) : null,
    has_attachments: Boolean(raw?.hasAttachments),
    received_at: receivedAt,
    sent_at: sentAt,
    raw_graph_payload: sanitizeGraphPayload(raw, form)
  };

  const conversation = {
    graph_conversation_id: conversationId,
    subject: raw?.subject || null,
    // Requester identity comes from the inbound sender. Store only the hash on
    // the ticket (raw address stays on the message), matching orders.customer_email_hash.
    requester_email_hash: isInbound ? hashIdentifier(fromEmail) : null,
    requester_name: isInbound ? fromName : null,
    message_at: messageAt
  };

  return {
    removed: false,
    graphMessageId: message.graph_message_id,
    conversationId,
    message,
    conversation,
    // Structured facts the customer typed rather than the model inferred. The
    // ticket writer decides what to persist; declaredCategory and orderNumber
    // stay null until the Shopify form grows those inputs.
    contactForm: form
  };
}

/**
 * A message sent by the support mailbox itself is our own reply sitting in the
 * Inbox, not customer mail. Without `mailbox` the caller gets the old behaviour
 * (everything inbound), so a caller that has not been updated is unchanged
 * rather than silently mis-classified.
 */
function resolveDirection(fromEmail, mailbox) {
  if (!mailbox || !fromEmail) {
    return 'inbound';
  }
  return fromEmail.trim().toLowerCase() === mailbox.trim().toLowerCase() ? 'outbound' : 'inbound';
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
//
// For contact-form mail this is also where the ORIGINAL envelope survives: from
// is overwritten above with the customer named in the body, and losing the fact
// that Shopify actually sent it would make the row impossible to audit.
function sanitizeGraphPayload(raw, form = null) {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  return {
    ...(form
      ? {
          contactForm: {
            countryCode: form.countryCode,
            phone: form.phone,
            declaredCategory: form.declaredCategory,
            orderNumber: form.orderNumber,
            envelopeFrom: raw.from?.emailAddress ?? null
          }
        }
      : {}),
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

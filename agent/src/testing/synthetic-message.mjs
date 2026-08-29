import { randomUUID } from 'node:crypto';

import { hashIdentifier, maskEmail } from '../../../scripts/lib/compliance-audit.mjs';

// One typed message, in the shape the database would have held it.
//
// The rehearsal's entry point. Everything downstream — the ticket record, the
// categoriser, the investigation, drafting — reads rows, so the only honest way
// to run them against an invented situation is to build the rows an invented
// email would have produced and change nothing else.
//
// WHERE THE IDENTITY COMES FROM, and why it is fields rather than prose. On a
// real email the sender is the ENVELOPE: ingestion takes `from_email` off the
// Graph message and `requester_email_hash` off that, and no parser ever reads an
// address out of the body. A test chat has no envelope, so the operator supplies
// one. Asking them to write "je suis Marie, marie@x.fr" in the message instead
// would mean inventing a parser production does not have, and testing it.
//
// THE ORDER NUMBER IS THE OPPOSITE CASE and is handled the opposite way. On a
// real email it IS in the body — `shopifyOrderCandidates` finds it there — so an
// order number supplied here is APPENDED to the message text rather than written
// onto the ticket. The resolver then has to find it exactly as it would live. A
// rehearsal that stamped `shopify_order_number` directly would skip the pass it
// is meant to be testing and report a confidence the pipeline has not earned.

/**
 * The line an order number is appended as, so the transcript can show it.
 *
 * THE `#` IS ADDED WHEN THE OPERATOR OMITS IT, and that is not cosmetic. The
 * parser takes a bare number as a candidate only when `commande` sits directly
 * in front of it (`commande 6513`, `commande n° 6513`); the colon in this line
 * breaks that adjacency, so `Ma commande : 6513` parsed to NOTHING and the run
 * reported "no order number in the message" for a number the operator had
 * typed into the field. The pipeline then behaved correctly for a ticket with
 * no order — order tool unresolved, `order_unconfirmed`, escalated — which
 * reads as a drafting failure and is not one.
 *
 * `#6513` is also how the corpus overwhelmingly writes it: 1152 messages
 * against 225 spelled out. Left alone if the operator already typed one.
 */
export const ORDER_LINE = (orderNumber) => {
  const value = String(orderNumber).trim();
  return `Ma commande : ${/^\d/.test(value) ? `#${value}` : value}`;
};

/**
 * @param input {{ name, email, subject, body, orderNumber }}
 * @param context {{ shopId, now }}
 * @returns {{ ticket, message, firstInbound, bodyText }}
 */
export function buildSyntheticTicket(input = {}, { shopId, now = new Date() } = {}) {
  if (!shopId) {
    throw new Error('buildSyntheticTicket requires a shopId.');
  }
  const body = String(input.body || '').trim();
  if (!body) {
    throw new Error('A rehearsal needs a message.');
  }

  const at = now.toISOString();
  const ticketId = randomUUID();
  const messageId = randomUUID();

  const email = normaliseEmail(input.email);
  const name = textOrNull(input.name);
  const subject = textOrNull(input.subject) || '(sans objet)';
  const orderNumber = textOrNull(input.orderNumber);
  const bodyText = orderNumber ? `${body}\n\n${ORDER_LINE(orderNumber)}` : body;

  const ticket = {
    id: ticketId,
    shop_id: shopId,
    // The Graph identifiers a real thread is keyed on. Random rather than
    // omitted: nothing in a rehearsal threads or deduplicates, but a null
    // conversation id would be a shape ingestion never produces.
    graph_conversation_id: `rehearsal-${ticketId}`,
    subject,
    status: 'open',

    // The queue state a freshly ingested thread is in: labels pending,
    // investigation not yet raised. `claim` reads exactly these.
    needs_categorisation: true,
    needs_investigation: false,

    category: null,
    request_kind: null,
    secondary_category: null,
    secondary_request_kind: null,
    level: null,
    responsible_team: null,
    language: null,
    happiness: null,
    categorisation_confidence: null,

    // Identity as the ticket holds it: a hash, and the name off the envelope.
    requester_email_hash: email ? hashIdentifier(email) : null,
    requester_name: name,
    customer_id: null,

    shopify_order_number: null,
    resolved_context: null,
    context_resolved_at: null,

    // No link of either kind can exist on a thread with one message and no
    // history. Present and null rather than absent, because the drafting pass
    // reads both and a missing key would read as `undefined` rather than "no
    // link".
    duplicate_of_ticket_id: null,
    duplicate_reason: null,
    related_ticket_id: null,
    related_score: null,
    // The operator is not one of ours writing in; a label here would skip
    // drafting entirely (`draftDecision` -> internal_sender).
    sender_label: null,

    first_message_at: at,
    last_message_at: at,
    categorised_at: null,
    investigated_at: null,
    archived_at: null,
    deleted_at: null,
    metadata: {}
  };

  const message = {
    id: messageId,
    ticket_id: ticketId,
    shop_id: shopId,
    graph_message_id: `rehearsal-${messageId}`,
    direction: 'inbound',
    from_email: email,
    from_name: name,
    subject,
    body_text: bodyText,
    received_at: at,
    sent_at: null,
    has_attachments: false,
    // `[]` means fetched and empty, `null` means never fetched. A typed message
    // genuinely has no attachment, so `[]` is the true answer and the photo
    // check reads it as "nothing attached" rather than "not asked".
    attachments: [],
    // No vector: nothing in a rehearsal matches exemplars by embedding off the
    // message row, and inventing one would be inventing a similarity.
    embedding: null,
    deleted_at: null
  };

  return {
    ticket,
    message,
    bodyText,
    // `ticket_first_inbound` is a view over one message per ticket; order
    // resolution reads it rather than the message table.
    firstInbound: { ticket_id: ticketId, shop_id: shopId, subject, body_text: bodyText },
    identity: { email, hash: ticket.requester_email_hash, masked: maskEmail(email) }
  };
}

function textOrNull(value) {
  const text = String(value ?? '').trim();
  return text === '' ? null : text;
}

function normaliseEmail(value) {
  const text = textOrNull(value);
  return text ? text.toLowerCase() : null;
}

// Is this new ticket the same ONGOING CONVERSATION as one we already hold —
// without being a duplicate of it?
//
// THE DISTINCTION IS THE WHOLE MODULE. `duplicate-rules.mjs` answers "is this
// the same message twice", deterministically, and its consequence is silence:
// a linked ticket gets no draft. This answers a weaker question with a weaker
// method, and its consequence is the opposite of silence — a related match
// means the customer has written to us before about this and is very often
// still waiting, which is owed an APOLOGY rather than nothing.
//
// SO NOTHING HERE SUPPRESSES A REPLY. That is not an oversight; it is the
// reason a similarity score is allowed to be involved at all. A wrong duplicate
// link costs a customer their answer. A wrong related link costs an unnecessary
// apology and a line in the dialog. Only the second is safe to decide from an
// embedding.
//
// MEASURED ON THE CORPUS (2026-08-19), same sender, cross-ticket, within 30
// days. At 0.90 there are 25 consumer pairs, 18 of them more than an hour apart
// and 14 already replied to: they are chases and continuing threads, not
// double-posts. Eleven pairs are unanswered — customers who wrote again and got
// nothing, and whom the in-thread chase check cannot see because the second
// message opened a NEW ticket.
//
// WHY LISTED SENDERS ARE EXCLUDED, and why same-sender scoping does not save
// you from them. A retailer sends the same purchase-order template every week
// with a different reorder number: Nocibé's pairs score 0.9945-0.9981, HIGHER
// than any genuine consumer match except byte-identical text. They are the same
// sender by construction, so scoping to one sender is exactly what fails to
// separate them, and no threshold can: the false positives sit above the true
// ones. `sender_directory` already knows who they are — an address absent from
// it is a consumer, which is the definition this codebase already uses.
//
// CATEGORY IS NOT THE FILTER, though it looks like one. The categoriser labels
// by SUBJECT, correctly, so Nocibé's mail is spread across b2b/order/delivery —
// and the single worst false positive in the corpus (0.9957, two different
// lists of late orders) wears `delivery`. Filtering on category catches 13 of
// the 14; filtering on the directory catches 14 of 14.

/** Cosine at or above which two messages are the same conversation. */
export const RELATED_THRESHOLD = 0.9;

/** How far back a related ticket may be. Matches the duplicate pool. */
export const RELATED_WINDOW_DAYS = 30;

/**
 * Below this, two messages are close enough in time that `duplicate-rules`
 * owns the decision and this one should stay out of it.
 */
export const MIN_RELATED_GAP_MS = 60 * 60 * 1000;

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** pgvector comes back as a JSON string over PostgREST. */
export function toVector(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The strongest related prior for this message, or null.
 *
 * @param candidate      the new message: `embedding`, `received_at`
 * @param priorMessages  the same sender's earlier inbound messages, each with
 *                       `ticket_id`, `embedding`, `received_at`. The caller has
 *                       already excluded listed senders and closed the window.
 * @param outboundAfter  timestamps of our own messages to this sender, used to
 *                       decide whether the customer was left waiting.
 */
export function findRelated({
  candidate,
  priorMessages = [],
  outboundAt = [],
  threshold = RELATED_THRESHOLD
} = {}) {
  const vector = toVector(candidate?.embedding);
  if (!vector) {
    return null;
  }
  const at = Date.parse(candidate?.received_at ?? '');
  if (!Number.isFinite(at)) {
    return null;
  }

  let best = null;
  for (const prior of priorMessages) {
    if (!prior?.ticket_id || prior.ticket_id === candidate?.ticket_id) {
      continue;
    }
    const priorAt = Date.parse(prior.received_at ?? '');
    if (!Number.isFinite(priorAt)) {
      continue;
    }
    // Strictly earlier, and far enough back that this is not the double-post
    // `duplicate-rules` is there to catch.
    const gap = at - priorAt;
    if (gap < MIN_RELATED_GAP_MS || gap > RELATED_WINDOW_DAYS * 86400000) {
      continue;
    }
    const priorVector = toVector(prior.embedding);
    if (!priorVector) {
      continue;
    }
    const score = cosine(vector, priorVector);
    if (score >= threshold && (!best || score > best.score)) {
      best = { ticketId: prior.ticket_id, score, at: prior.received_at, gap };
    }
  }

  if (!best) {
    return null;
  }

  // DID WE ANSWER IN BETWEEN? The same evidence separates "still waiting" from
  // "we replied and they came back", and only the first is owed an apology.
  const answered = outboundAt.some((stamp) => {
    const outAt = Date.parse(stamp ?? '');
    return Number.isFinite(outAt) && outAt > Date.parse(best.at) && outAt < at;
  });

  return { ...best, chased: !answered };
}

/**
 * The narrow pool `findRelated` decides against, and the sender gate in front
 * of it.
 *
 * SHAPED LIKE `createDuplicateLookup` ON PURPOSE — same sender key, same 30-day
 * window, same "the caller narrows, the rules decide" split — with two
 * differences that matter:
 *
 *   IT REFUSES LISTED SENDERS OUTRIGHT, before any query runs. A retailer or a
 *   3PL sends structured mail on a template, and template-versus-template is
 *   the one comparison an embedding cannot make. `sender_directory` is the
 *   existing answer to "who is this", and an address absent from it is a
 *   consumer.
 *
 *   IT CARRIES EMBEDDINGS AND OUR OWN TIMESTAMPS. The vectors are the decision;
 *   the outbound timestamps are how "they wrote again" is separated from "they
 *   wrote again AND we never answered", which is the difference between context
 *   and an apology.
 */
export function createRelatedLookup({
  supabase,
  shopId,
  select,
  senderDirectory,
  windowDays = RELATED_WINDOW_DAYS
}) {
  return {
    async priorMessages({ requesterEmailHash, fromEmail, before }) {
      if (!requesterEmailHash) {
        return { priorMessages: [], outboundAt: [] };
      }
      // The gate. Cheap, and it is the only thing standing between this and a
      // distributor's purchase orders being declared one conversation.
      if (senderDirectory?.lookup?.(fromEmail)) {
        return { priorMessages: [], outboundAt: [] };
      }

      const since = new Date(
        (Date.parse(before ?? '') || Date.now()) - windowDays * 86400000
      ).toISOString();

      const tickets = await select(
        supabase,
        'tickets',
        {
          shop_id: shopId,
          requester_email_hash: requesterEmailHash,
          deleted_at: { operator: 'is', value: 'null' },
          last_message_at: { operator: 'gte', value: since }
        },
        'id'
      );
      if (tickets.length === 0) {
        return { priorMessages: [], outboundAt: [] };
      }

      const ids = `(${tickets.map((t) => t.id).join(',')})`;
      const messages = await select(
        supabase,
        'ticket_messages',
        { shop_id: shopId, ticket_id: { operator: 'in', value: ids } },
        'ticket_id,direction,received_at,embedding'
      );

      return {
        priorMessages: messages.filter((m) => m.direction === 'inbound' && m.embedding),
        // Every reply we sent this sender in the window, whichever thread it
        // went out on: "did we answer" is a question about the person, not
        // about one conversation id.
        outboundAt: messages.filter((m) => m.direction === 'outbound').map((m) => m.received_at)
      };
    }
  };
}

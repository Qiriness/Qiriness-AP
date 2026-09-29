// Decides which messages on a routed ticket leave the support inbox, when, what
// the covering note says, and whether the sender is told.
//
// Pure: no Graph, no Supabase, no clock. Everything here is a decision, so the
// decisions are unit-testable and the runner stays a thin shell around them.

import { isInternalSender } from '../../../scripts/lib/message-audience.mjs';
import { isAutomatedAddress } from '../../../scripts/lib/forwarding-destinations.mjs';

/** How many times a failed acknowledgement is retried before it is left visible as failed. */
export const MAX_ACK_ATTEMPTS = 5;

/**
 * Whether one message on a routed ticket may be handed to a colleague.
 *
 * WHERE the ticket goes is the router's (destination-router.mjs). This is the
 * part that is about the message: a colleague forwarding something INTO the
 * inbox is `inbound` too — 9 of 51 pending messages on the first real count
 * were from our own domain, subjects prefixed `TR:` and `RE:` — and handing it
 * back under « nous avons reçu » is both wrong and confusing.
 */
export function shouldForwardMessage({ fromEmail, internalDomains = [] }) {
  return !isInternalSender(fromEmail, internalDomains);
}

/**
 * Whether the destination takes the thread yet.
 *
 * `after_first_reply` waits for an outbound message on the ticket: our reply
 * asks the customer for what that team needs (the batch number, the place of
 * purchase), and the colleague should receive the thread with it asked. An
 * outbound message is what the outbound worker's send or a colleague replying
 * with support in copy leaves behind — both are read back from the mailbox.
 */
export function isReadyToForward({ destination, hasOutbound }) {
  return destination?.timing !== 'after_first_reply' || Boolean(hasOutbound);
}

/**
 * What to do about the acknowledgement once something has been forwarded.
 *
 * Returns `{ action: 'none' }` when there is nothing to decide (already done,
 * or the destination does not acknowledge), `{ action: 'skip', reason }` when
 * the answer is « never for this ticket », and `{ action: 'send' }`.
 *
 * SWITCHED OFF MEANS SKIPPED, NOT PENDING. A ticket forwarded while
 * acknowledgements were off is marked skipped, so turning them on later does not
 * send a week-old « we have passed it on » to everyone forwarded meanwhile.
 */
export function planAcknowledgement({ settings, destination, routing, recipient, internalDomains = [] }) {
  if (destination?.timing !== 'immediate' || !destination?.acknowledge) {
    return { action: 'none' };
  }
  const state = routing?.ack_state ?? null;
  if (state === 'sent' || state === 'requested' || state === 'skipped') {
    return { action: 'none' };
  }
  if (state === 'failed' && (routing?.ack_attempts ?? 0) >= MAX_ACK_ATTEMPTS) {
    return { action: 'none' };
  }
  if (!settings?.ack_enabled) {
    return { action: 'skip', reason: 'acknowledgements_off' };
  }
  if (!String(recipient ?? '').includes('@')) {
    return { action: 'skip', reason: 'no_recipient' };
  }
  if (isInternalSender(recipient, internalDomains)) {
    return { action: 'skip', reason: 'internal_sender' };
  }
  if (isAutomatedAddress(recipient)) {
    return { action: 'skip', reason: 'automated_sender' };
  }
  return { action: 'send' };
}

/**
 * The covering note. In French: Qiriness is a French company and this is
 * internal mail between colleagues.
 *
 * Short, warm, and done. No greeting by name (the address book holds a mailbox,
 * which may be a shared one), no signature (it is visibly from the support
 * inbox), no instructions (they know their job better than the agent does). The
 * forwarded email travels underneath in full, so the note must not summarise or
 * paraphrase it — a wrong paraphrase is worse than none, and the reader is one
 * scroll from the original.
 *
 * The subject line is included because the note sits above a quoted chain and
 * that is the one piece of context a reader wants before scrolling.
 *
 * NO TU/VOUS PROBLEM AND NO AGREEMENT PROBLEM, by construction. The recipient
 * may be a person or a shared mailbox, so the note never addresses them
 * directly; and the closing refers to `le message` — invariably masculine —
 * rather than a pronoun standing in for the category phrase, which would need
 * to agree in gender with each one ("je vous *la* transmets" for une
 * candidature, "*le*" for un signalement). One wrong agreement in mail that
 * goes out unattended is exactly the kind of thing nobody fixes.
 */
export function buildForwardNote({ category, subject, afterReply = false } = {}) {
  const label = CATEGORY_PHRASING[category] || 'un message';
  const trimmed = String(subject || '').replace(/\s+/g, ' ').trim();
  const line = trimmed ? `${label} — « ${truncate(trimmed, 120)} »` : label;
  return (
    `Bonjour,\n\n` +
    `Pour information, nous avons reçu ${line} dans la boîte contact.\n` +
    // A destination that waits for our reply receives the thread after the
    // customer has been asked for what it needs; saying so stops the colleague
    // asking the same questions a second time.
    (afterReply ? `Une première réponse a déjà été envoyée à l'expéditeur.\n` : '') +
    `Je vous transmets le message ci-dessous.\n\n` +
    `Merci !`
  );
}

/**
 * How each category is described in the note. Written as the noun phrase that
 * follows "nous avons reçu", article included, so the sentence reads naturally
 * in every case. Only the three categories the taxonomy allows `contact` for
 * can realistically appear; the rest are here so a future routing rule cannot
 * produce an ungrammatical note.
 */
const CATEGORY_PHRASING = {
  careers: 'une candidature',
  b2b: 'une demande commerciale (B2B)',
  partner_collaboration: 'une demande de partenariat',
  promotions: 'une question sur une promotion',
  legal_privacy: 'une demande juridique ou RGPD',
  cosmetovigilance: 'un signalement de cosmétovigilance',
  payment: 'une question de paiement',
  order: 'une demande concernant une commande',
  delivery: 'une demande concernant une livraison',
  return_exchange: 'une demande de retour ou d\'échange',
  product: 'une question produit',
  product_stock: 'une question de disponibilité',
  account: 'une question sur un compte',
  other: 'un message'
};

function truncate(value, max) {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Does this failure say "not now" rather than "not ever"?
 *
 * WHY THE DISTINCTION IS LOAD-BEARING. Attempts are capped so an undeliverable
 * address cannot be retried forever — but the worker polls every 60 seconds, so
 * an uncapped-by-type counter burns all five attempts in five minutes. The first
 * real run hit ErrorMailboxMoveInProgress: Exchange was migrating the mailbox
 * between databases, which resolves itself in hours. Counting those would have
 * permanently abandoned 42 genuine emails minutes before they became sendable.
 *
 * So a transient failure is still recorded — it must stay visible — but does not
 * consume an attempt. Only errors that indicate something a human has to change
 * (a wrong address, a revoked permission) count towards the cap.
 */
export function isTransientGraphError(message) {
  return TRANSIENT_GRAPH_ERRORS.some((code) =>
    String(message || '').toLowerCase().includes(code.toLowerCase())
  );
}

const TRANSIENT_GRAPH_ERRORS = [
  'ErrorMailboxMoveInProgress', // mailbox migrating between databases
  'ErrorMailboxStoreUnavailable',
  'ErrorServerBusy',
  'ErrorTimeoutExpired',
  'ErrorInternalServerError',
  'ErrorTooManyObjectsOpened',
  'ApplicationThrottled',
  'ServiceUnavailable',
  'HTTP 429',
  'HTTP 502',
  'HTTP 503',
  'HTTP 504'
];

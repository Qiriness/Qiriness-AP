// Decides which mail leaves the support inbox for a colleague, and what the
// covering note says.
//
// Pure: no Graph, no Supabase, no clock. Everything here is a decision, so the
// decisions are unit-testable and the runner stays a thin shell around them.

import { isInternalSender } from '../../../scripts/lib/message-audience.mjs';

/**
 * The rule, deliberately narrow: the ticket asks nothing of customer support
 * (`request_kind = 'contact'`), its category has an address configured, AND the
 * message came from outside.
 *
 * The first two halves matter because routing on the category alone would sweep
 * in real work — `b2b` also holds reorder problems that need action, and a
 * configured address would quietly divert them — while routing on the kind alone
 * would have nowhere to send it. The taxonomy already restricts `contact` to
 * b2b, partner_collaboration and careers, so this is 38 of 330 tickets on the
 * measured corpus, and nothing a customer is waiting on.
 *
 * THE SENDER CHECK was added after counting a real pass: 9 of 51 pending
 * messages were from our own domain — colleagues forwarding things *into* the
 * inbox, subjects prefixed `TR:` and `RE:`. `direction` only catches mail sent
 * by the support mailbox itself, so a colleague writing from their own address
 * is `inbound` and would have been handed back to a colleague under the words
 * "nous avons reçu", which is both wrong and confusing. Same idea, and the same
 * module, as the audience split in the clustering report.
 *
 * Level is not consulted. `contact` derives level 2 and only ever climbs by
 * escalation; if a ticket has escalated past that, the kind will have been
 * re-categorised too, and this returns false on its own.
 */
export function shouldForward({ ticket, fromEmail, addressByCategory, internalDomains = [] }) {
  if (!ticket || ticket.request_kind !== 'contact') {
    return false;
  }
  if (isInternalSender(fromEmail, internalDomains)) {
    return false;
  }
  return Boolean(resolveAddress(ticket.category, addressByCategory));
}

/** The configured recipient for a category, or null when it must not forward. */
export function resolveAddress(category, addressByCategory) {
  const raw = addressByCategory?.get?.(category) ?? addressByCategory?.[category];
  const address = String(raw || '').trim();
  return address.includes('@') ? address : null;
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
export function buildForwardNote({ category, subject } = {}) {
  const label = CATEGORY_PHRASING[category] || 'un message';
  const trimmed = String(subject || '').replace(/\s+/g, ' ').trim();
  const line = trimmed ? `${label} — « ${truncate(trimmed, 120)} »` : label;
  return (
    `Bonjour,\n\n` +
    `Pour information, nous avons reçu ${line} dans la boîte contact.\n` +
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

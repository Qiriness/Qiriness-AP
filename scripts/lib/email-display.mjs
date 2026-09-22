import { findQuoteBoundary } from './quoted-reply.mjs';

// A presentation-only projection of stored email text. The source body is never
// changed: callers keep it as `raw`, while this module decides which parts are
// useful in the default conversation view and which belong behind disclosures.

const SP = '[ \\t\\u00a0]';

// Forward banners as mail clients actually write them in this mailbox: Yahoo FR
// says "transmis", Apple Mail FR "réexpédié", and the Spanish/Italian/German
// clients their own words. Each was a real ticket repeating its whole history.
const FORWARD_WORDS = [
  'Message transf[ée]r[ée]', 'Message transmis', 'Message r[ée]exp[ée]di[ée]',
  'Forwarded message', 'Original Message', 'Mensaje reenviado', 'Messaggio inoltrato',
  'Weitergeleitete Nachricht', 'Mensagem encaminhada',
].join('|');

const FORWARD_MARKER = new RegExp(
  `^(?:${SP}*-{2,}${SP}*(?:${FORWARD_WORDS})${SP}*-{2,}|${SP}*(?:D[ée]but du message (?:transf[ée]r[ée]|r[ée]exp[ée]di[ée])|Begin forwarded message|Inizio messaggio inoltrato)${SP}*:?)`,
  'im'
);

// Boundaries the shared splitter (`quoted-reply.mjs`) does not know. Kept here
// rather than there: that splitter feeds embeddings and the agents, and
// widening it re-embeds the corpus — a separate decision from what the
// conversation view hides.
const DISPLAY_BOUNDARIES = [
  FORWARD_MARKER,
  // "El jue, 16 jul 2026, 15:39, X escribió:" / "Il mer 2 set 2026, X ha scritto:"
  // / "Am … schrieb X:" / "Em … escreveu:" / "Op … schreef X:"
  new RegExp(`^${SP}*(?:El|Il|Am|Em|Op)${SP}[\\s\\S]{0,250}?(?:escribi[óo]|ha${SP}+scritto|schrieb|escreveu|schreef)[^\\n]{0,120}:`, 'im'),
  // Outlook/Orange header blocks in either line order and any case:
  // "envoyé : … \n de : …" as well as "De: … \n Enviado: …".
  new RegExp(`^${SP}*(?:Envoy[ée]|Enviado|Inviato|Gesendet|Sent)${SP}*:.*\\r?\\n${SP}*(?:De|From|Da|Von)${SP}*:`, 'im'),
  new RegExp(`^${SP}*(?:De|Da|Von)${SP}*:.*\\r?\\n${SP}*(?:Enviado|Inviato|Gesendet|Fecha|Data|Datum)${SP}*:`, 'im'),
];

const QUOTE_MESSAGE_MARKERS = [
  new RegExp(`^${SP}*(?:De|From|Da|Von)${SP}*:`, 'gim'),
  new RegExp(`^${SP}*(?:Le${SP}.{0,200}a${SP}+[ée]crit|On${SP}.{0,200}${SP}wrote|(?:El|Il|Am|Em|Op)${SP}.{0,250}(?:escribi[óo]|ha${SP}+scritto|schrieb|escreveu|schreef).{0,120})${SP}*:`, 'gim'),
  new RegExp(`^${SP}*-{2,}${SP}*(?:Message d['’]origine|${FORWARD_WORDS})${SP}*-{2,}`, 'gim'),
];

const SIGNATURE_LINE = /^(?:--[ \t]*|Bien cordialement[,.]?[ \t]*|Cordialement[,.]?[ \t]*|Sincèrement[,.]?[ \t]*|Best regards[,.]?[ \t]*|Kind regards[,.]?[ \t]*|Regards[,.]?[ \t]*|Sent from my (?:iPhone|iPad|Android).*$|Envoyé de mon (?:iPhone|iPad|téléphone).*$|Get Outlook for .*$)/i;

const DISCLAIMER_LINE = /^(?:Ce message et (?:ses|toutes) pièces jointes|This (?:e-?mail|message) and any attachments|AVERTISSEMENT[ \t]*:|CONFIDENTIALIT[ÉE][ \t]*:)/i;

/**
 * @param {string|null|undefined} body
 * @returns {{raw: string|null, bodyClean: string|null, quotedBody: string|null,
 *   signature: string|null, forwardedContent: string|null, quotedMessageCount: number,
 *   isForward: boolean}}
 */
export function parseEmailForDisplay(body) {
  if (typeof body !== 'string' || body.trim().length === 0) {
    return emptyDisplay(body ?? null);
  }

  const raw = body;
  const quoteBoundary = findDisplayBoundary(raw);
  const forwardMatch = FORWARD_MARKER.exec(raw);
  const isForward = Boolean(forwardMatch);

  let own = quoteBoundary === null ? raw : raw.slice(0, quoteBoundary).trimEnd();
  let remainder = quoteBoundary === null ? null : raw.slice(quoteBoundary).trim() || null;

  // The shared quote splitter deliberately keeps a bare forward as the message
  // body so agents never receive an empty question. The UI has a different job:
  // it can name the forward and put the transported thread behind a disclosure.
  if (isForward && forwardMatch && raw.slice(0, forwardMatch.index).trim().length === 0) {
    own = '';
    remainder = raw.slice(forwardMatch.index).trim();
  }

  const { bodyClean, signature } = splitSignature(own);
  const forwardedContent = isForward ? remainder : null;
  const quotedBody = isForward ? null : remainder;

  return {
    raw,
    bodyClean: bodyClean || null,
    quotedBody,
    signature,
    forwardedContent,
    quotedMessageCount: remainder ? countQuotedMessages(remainder) : 0,
    isForward,
  };
}

/** The earliest of the shared quote boundary and the display-only ones. */
function findDisplayBoundary(raw) {
  let earliest = findQuoteBoundary(raw);
  for (const marker of DISPLAY_BOUNDARIES) {
    const match = marker.exec(raw);
    if (match && (earliest === null || match.index < earliest)) earliest = match.index;
  }
  return earliest;
}

function emptyDisplay(raw) {
  return {
    raw,
    bodyClean: raw,
    quotedBody: null,
    signature: null,
    forwardedContent: null,
    quotedMessageCount: 0,
    isForward: false,
  };
}

/** A conservative end-of-message split: only conventional closing markers. */
function splitSignature(body) {
  const text = String(body ?? '').trim();
  if (!text) return { bodyClean: '', signature: null };

  const lines = text.split(/\r?\n/);
  const earliest = Math.max(1, lines.length - 12);
  for (let index = earliest; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (SIGNATURE_LINE.test(line) || DISCLAIMER_LINE.test(line)) {
      const bodyClean = lines.slice(0, index).join('\n').trimEnd();
      const signature = lines.slice(index).join('\n').trim();
      if (bodyClean) return { bodyClean, signature: signature || null };
    }
  }
  return { bodyClean: text, signature: null };
}

function countQuotedMessages(text) {
  let count = 0;
  for (const marker of QUOTE_MESSAGE_MARKERS) {
    marker.lastIndex = 0;
    count = Math.max(count, [...text.matchAll(marker)].length);
  }
  return Math.max(1, count);
}


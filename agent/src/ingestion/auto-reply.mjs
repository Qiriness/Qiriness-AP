// Is this message a machine answering our mail on someone's behalf?
//
// AN OUT-OF-OFFICE IS NOT THE CUSTOMER WRITING BACK. Found live 2026-10-05 on
// 35e0afd9: our P-15 reply went out at 10:37:19, the customer's iCloud vacation
// responder answered at 10:37:30, and ingestion filed it as the customer. The
// ticket reopened, `next_actor` went to support, the categoriser and the
// investigation re-ran on « je suis en congés jusqu'au 19 octobre », and the
// snooze our reply should have set would have been woken by it.
//
// PURE: headers and subject in, the signal that matched (or null) out. The
// signal is stored on the row (`raw_graph_payload.autoReply`) so a person can
// see why a message was set aside.
//
// HEADERS FIRST, SUBJECT LAST. Measured on that message: iCloud sends no
// `Auto-Submitted` at all, only its own `X-Apple-Action: VACATION`, so the RFC
// header alone would have missed the very case that found this. The subject is
// the fallback because it is localised by the sender's mail client and
// therefore never complete.
//
// ONLY REPLIES, NEVER NOTIFICATIONS. `Auto-Submitted: auto-generated` and
// `Precedence: bulk` also mark machine mail, but that is a Shopify contact-form
// notification, a carrier's tracking update, a newsletter: mail that opens or
// feeds a case. Only `auto-replied` (RFC 3834 § 5) means « an answer to yours,
// written by nobody ».

/**
 * Subject prefixes mail clients put on an automatic reply, lower case, matched
 * at the start of the subject. By language, not by business: which clients the
 * customers use is the only thing that varies, so one list serves every shop.
 */
export const AUTO_REPLY_SUBJECT_PREFIXES = Object.freeze([
  'auto reply:',
  'auto-reply:',
  'autoreply:',
  'automatic reply:',
  'out of office:',
  'out of office reply:',
  'réponse automatique',
  'reponse automatique',
  'absent(e) du bureau',
  'absence du bureau',
  'abwesenheitsnotiz',
  'automatische antwort',
  'respuesta automática',
  'respuesta automatica',
  'risposta automatica',
  'automatisch antwoord',
  'resposta automática'
]);

const header = (headers, name) => {
  if (!Array.isArray(headers)) return null;
  const wanted = name.toLowerCase();
  const found = headers.find((h) => String(h?.name || '').toLowerCase() === wanted);
  return typeof found?.value === 'string' ? found.value.trim() : null;
};

/**
 * The signal that marks this message as an automatic reply, or null.
 *
 * @param {{ headers?: Array<{name: string, value: string}>|null, subject?: string|null }} message
 * @returns {string|null} e.g. `header:auto-submitted`, `header:x-apple-action`, `subject`
 */
export function autoReplySignal({ headers = null, subject = null } = {}, { subjectPrefixes = AUTO_REPLY_SUBJECT_PREFIXES } = {}) {
  if (/^auto-replied\b/i.test(header(headers, 'auto-submitted') ?? '')) return 'header:auto-submitted';
  if (/^auto_reply$/i.test(header(headers, 'precedence') ?? '')) return 'header:precedence';
  if (/^(yes|true)$/i.test(header(headers, 'x-autoreply') ?? '')) return 'header:x-autoreply';
  if (header(headers, 'x-autorespond') !== null) return 'header:x-autorespond';
  if (/^vacation$/i.test(header(headers, 'x-apple-action') ?? '')) return 'header:x-apple-action';

  const lowered = String(subject ?? '').trim().toLowerCase();
  if (lowered && subjectPrefixes.some((prefix) => lowered.startsWith(prefix))) return 'subject';
  return null;
}

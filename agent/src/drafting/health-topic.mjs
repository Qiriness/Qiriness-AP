// Does the customer mention their own health in what this reply answers?
//
// THE TOPIC, NOT THE WORDING. A draft that says « vous pouvez l'utiliser sans
// problème » to someone with glaucoma needs no medical word to be wrong, so the
// check reads what the CUSTOMER wrote, never the draft. It decides one thing:
// whether the draft may send itself. The draft is still written.
//
// WHY NOT THE CATEGORY OR THE SITUATION. Ticket ba09c1ae (« Le masque Led Visage
// est-il déconseillé pour une personne ayant un GLAUCOME ? ») was filed
// `product`, level 1, and the chooser saw only product situations — CV-03 was
// never a candidate. Both of those gates exist and neither saw it.

import { stripQuotedReply } from '../../../scripts/lib/quoted-reply.mjs';
import { HEALTH_TERMS } from './health-terms.mjs';

/** Lower case, accents dropped, punctuation and hyphens as spaces. */
export function foldText(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
}

/** `contre indique*` → `contre +indique[a-z0-9]*`, over folded text. */
function termPattern(term) {
  return String(term)
    .trim()
    .split(/\s+/)
    .map((word) => foldText(word.replace(/\*$/, '')).trim() + (word.endsWith('*') ? '[a-z0-9]*' : ''))
    .join(' +');
}

/**
 * One regex per term list, so the matched term can be reported back by name.
 * Built once per list rather than per message.
 */
export function compileHealthTerms(terms = HEALTH_TERMS) {
  const all = [...new Set(Object.values(terms).flat())];
  return all.map((term) => ({ term, pattern: new RegExp(`(?:^| )${termPattern(term)}(?= |$)`) }));
}

const DEFAULT_COMPILED = compileHealthTerms();

/** The health terms in one piece of text, in list order, each named once. */
export function healthTermsIn(text, compiled = DEFAULT_COMPILED) {
  const folded = ` ${foldText(text)} `;
  return compiled.filter(({ pattern }) => pattern.test(folded)).map(({ term }) => term);
}

/**
 * The customer's own words this reply answers: their inbound messages up to and
 * including the trigger, quoted earlier mail removed.
 *
 * EARLIER MESSAGES COUNT. « J'ai un glaucome » on Monday and « alors, je peux
 * l'utiliser ? » on Tuesday is the same question, and the reply to Tuesday is
 * the one that could say yes.
 *
 * ONLY THE CUSTOMER. A colleague's note or the 3PL's update on the thread
 * (`actor` set and not `customer`) is not the customer describing themselves.
 * A row with no actor was stored before the column and is read as the customer,
 * which is what every other reader does with it.
 */
export function customerTextFor({ conversation = [], message = null, triggerMessageId = null } = {}) {
  const trigger = conversation.find((row) => row?.id === triggerMessageId);
  const until = Date.parse(trigger?.received_at || trigger?.sent_at || '');
  const texts = conversation
    .filter((row) => row?.direction === 'inbound')
    .filter((row) => !row.actor || row.actor === 'customer')
    .filter((row) => {
      if (!Number.isFinite(until)) return true;
      const at = Date.parse(row.received_at || row.sent_at || '');
      return !Number.isFinite(at) || at <= until;
    })
    .map((row) => stripQuotedReply(row.body_text || ''));
  // The trigger is always read, even when the thread came back without it.
  if (message?.body_text && !conversation.some((row) => row?.id === triggerMessageId)) {
    texts.push(stripQuotedReply(message.body_text));
  }
  return texts.join('\n');
}

/** The health terms the customer used in what this reply answers. */
export function healthTopicOf(input, compiled = DEFAULT_COMPILED) {
  return healthTermsIn(customerTextFor(input), compiled);
}

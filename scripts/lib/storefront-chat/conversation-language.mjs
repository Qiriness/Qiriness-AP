import { countryAnswer } from './knowledge-topics.mjs';
import { detectLanguage } from '../advisory/lexicon.mjs';
import { languageOf, wordsOf } from '../i18n/languages.mjs';

// A whole message that is no language switch (« oui », "thanks"), in every language (i18n/<code>/words.mjs, `neutral`).
// « si », « ja », « nein »: answers in languages the chat does not speak are no switch either.
const NEUTRAL = new RegExp(`^(${[...new Set([...wordsOf('neutral'), 'si', 'sí', 'ja', 'nein'])].join('|')})\\s*[.!?]*$`, 'i');

export function validReplyLanguage(value) {
  return typeof value === 'string' && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(value) ? value : null;
}

/** Metadata comes only from this server-owned session, never the widget locale. */
export function languageContext(message, history = [], choice = null) {
  const text = message.trim();
  const previous = [...history].reverse().find((m) => m.role === 'assistant' && validReplyLanguage(m.context?.replyLanguage));
  const neutral = Boolean(countryAnswer(text) || choice || !/[\p{L}]/u.test(text) || NEUTRAL.test(text));
  return {
    previous_language: validReplyLanguage(previous?.context?.replyLanguage),
    // What the message itself is written in, when it says (any language with a lexicon): the language deterministic text (chips) is shown in.
    message_language: neutral ? null : detectLanguage(text),
    neutral_followup: neutral,
    has_history: history.some((m) => m.role === 'user' || m.role === 'assistant')
  };
}

/**
 * The language for text the server writes itself (chip labels): the message's, then the conversation's,
 * then the page's (owner, 2026-10-30: « use the language parameters of the website »). Always one the
 * chat speaks: English for any other (languages.mjs).
 */
export function displayLanguage(language, locale) {
  return languageOf(language.message_language ?? language.previous_language ?? locale);
}

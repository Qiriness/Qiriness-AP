import { countryAnswer } from './knowledge-topics.mjs';
import { detectLanguage } from '../advisory/lexicon.mjs';

export function validReplyLanguage(value) {
  return typeof value === 'string' && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(value) ? value : null;
}

/** Metadata comes only from this server-owned session, never the widget locale. */
export function languageContext(message, history = [], choice = null) {
  const text = message.trim();
  const previous = [...history].reverse().find((m) => m.role === 'assistant' && validReplyLanguage(m.context?.replyLanguage));
  const neutral = Boolean(countryAnswer(text) || choice || !/[\p{L}]/u.test(text) || /^(yes|no|ok|okay|oui|non|si|sí|ja|nein|thanks|merci|thank you)\s*[.!?]*$/i.test(text));
  return {
    previous_language: validReplyLanguage(previous?.context?.replyLanguage),
    // What the message itself is written in, when it says (fr/en): the language deterministic text (chips) is shown in.
    message_language: neutral ? null : detectLanguage(text),
    neutral_followup: neutral,
    has_history: history.some((m) => m.role === 'user' || m.role === 'assistant')
  };
}

/** The language for text the server writes itself (chip labels): the message's, then the conversation's, then the page's. */
export function displayLanguage(language, locale) {
  return language.message_language ?? language.previous_language?.slice(0, 2) ?? String(locale || 'fr').slice(0, 2);
}

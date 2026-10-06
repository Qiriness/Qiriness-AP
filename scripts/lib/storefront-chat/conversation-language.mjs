import { countryAnswer } from './knowledge-topics.mjs';

export function validReplyLanguage(value) {
  return typeof value === 'string' && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(value) ? value : null;
}

/** Metadata comes only from this server-owned session, never the widget locale. */
export function languageContext(message, history = [], choice = null) {
  const text = message.trim();
  const previous = [...history].reverse().find((m) => m.role === 'assistant' && validReplyLanguage(m.context?.replyLanguage));
  const neutral = Boolean(countryAnswer(text) || choice || !/[\p{L}]/u.test(text) || /^(yes|no|ok|okay|oui|non|si|sí|ja|nein|thanks|merci|thank you)\s*[.!?]*$/i.test(text));
  return { previous_language: validReplyLanguage(previous?.context?.replyLanguage), neutral_followup: neutral, has_history: history.some((m) => m.role === 'user' || m.role === 'assistant') };
}

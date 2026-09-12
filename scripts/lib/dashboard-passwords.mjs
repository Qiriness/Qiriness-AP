/**
 * What this app demands of a dashboard password before handing it to Supabase.
 *
 * SUPABASE STORES AND CHECKS PASSWORDS; this file never sees a hash. It exists
 * because the project's own minimum (12 characters) is stricter than the
 * Supabase default, and because a password refused here is refused before it
 * travels anywhere — the `npm run users` prompt says why, in words, instead of
 * relaying a 422 from an API.
 *
 * Length over composition rules: a 12-character passphrase resists guessing
 * better than eight characters with a digit and a symbol, and people can
 * remember it.
 */

export const MIN_PASSWORD_LENGTH = 12;

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `The password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (password.length > 256) return { ok: false, error: 'The password must be at most 256 characters.' };
  if (/^(.)\1+$/.test(password)) return { ok: false, error: 'The password cannot be one character repeated.' };
  return { ok: true };
}

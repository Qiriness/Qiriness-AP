/**
 * What the storefront widget may send, checked before anything else reads it.
 * The browser is the public internet: every field is bounded, typed, and
 * anything unrecognised is dropped rather than passed on.
 *
 * Request: { sessionId?, message, action?, choice?, context? }
 *   choice  the value of a chip the customer clicked: a product id or a care type
 *           (resolver clarification), or `profile:<field>:<value>` (advisor question)
 */

export const MAX_MESSAGE_CHARS = 1000;
import { normalizeSnapshot } from './shopping-evaluator.mjs';

export const MAX_BODY_BYTES = 32 * 1024;

/** The quick actions the widget offers. Anything else is sent as a plain message. */
export const QUICK_ACTIONS = ['find_product', 'build_routine', 'compare', 'delivery_returns', 'offers'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_TYPE = /^[a-z_]{1,40}$/;
const HANDLE = /^[\p{Ll}\p{Lo}\p{N}_-]{1,255}$/u;
const LOCALE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
const COUNTRY = /^[A-Z]{2}$/;
const MAX_PATH_CHARS = 300;
// A product id, a care type, or a profile answer (`profile:skin_type:dry`, `profile:current_routine:cleanser+moisturiser`).
const CHOICE = /^[\p{L}\p{N} _'’:+-]{1,80}$/u;

export class ChatRequestError extends Error {}

/**
 * @typedef {object} ChatContext
 * @property {string | null} pageType
 * @property {string | null} productHandle
 * @property {string | null} collectionHandle
 * @property {string | null} locale
 * @property {string | null} [country]
 * @property {string | null} path
 */

/**
 * @returns {{ sessionToken: string | null, message: string, action: string | null, choice: string | null, context: ChatContext }}
 * @throws {ChatRequestError} with a message safe to return to the browser
 */
export function parseChatRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ChatRequestError('Expected a JSON object.');

  const message = typeof body.message === 'string' ? body.message.replace(/\u0000/g, '').trim() : '';
  if (!message) throw new ChatRequestError('message is required.');
  if (message.length > MAX_MESSAGE_CHARS) throw new ChatRequestError(`message is limited to ${MAX_MESSAGE_CHARS} characters.`);

  return {
    // An unknown or malformed token is not an error: the session starts afresh.
    sessionToken: typeof body.sessionId === 'string' && UUID.test(body.sessionId) ? body.sessionId.toLowerCase() : null,
    message,
    action: QUICK_ACTIONS.includes(body.action) ? body.action : null,
    choice: typeof body.choice === 'string' && CHOICE.test(body.choice) ? body.choice : null,
    context: parseContext(body.context),
    ...(body.cart !== undefined ? { cart: normalizeSnapshot(body.cart) } : {})
  };
}

/** @returns {ChatContext} */
function parseContext(raw) {
  const context = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const pick = (value, pattern) => (typeof value === 'string' && pattern.test(value) ? value : null);
  return {
    pageType: pick(context.pageType, PAGE_TYPE),
    productHandle: pick(context.productHandle, HANDLE),
    collectionHandle: pick(context.collectionHandle, HANDLE),
    locale: pick(context.locale, LOCALE),
    ...(pick(context.country, COUNTRY) ? { country: context.country } : {}),
    ...(pick(context.currency, /^[A-Z]{3}$/) ? { currency: context.currency } : {}),
    ...(pick(context.market, /^gid:\/\/shopify\/Market\/[1-9][0-9]{0,19}$/) ? { market: context.market } : {}),
    ...(pick(context.variantId, /^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]{0,19}$/) ? { variantId: context.variantId } : {}),
    ...(typeof context.loggedIn === 'boolean' ? { loggedIn: context.loggedIn } : {}),
    path: cleanPath(context.path)
  };
}

/** A same-site path only, without query or fragment: those can carry an email from a link. */
function cleanPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null;
  const path = value.split(/[?#]/)[0];
  return path.length <= MAX_PATH_CHARS ? path : path.slice(0, MAX_PATH_CHARS);
}

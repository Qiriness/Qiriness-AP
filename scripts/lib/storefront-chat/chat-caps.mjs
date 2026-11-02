import { supabaseSelect, supabaseUpdate } from '../supabase-rest-client.mjs';
import { T } from '../tables.mjs';

/**
 * THE STOREFRONT CHAT'S TWO CAPS, a number each, set on Storefront Agent →
 * Dashboard for each shop the advisor answers, held on that shop's `shops` row
 * (migration storefront_chat_caps) and read by the chat service before any
 * model call:
 *   - `daily`: customer messages the whole shop may send over the last 24 hours
 *     (a rolling window). Past it nobody is answered until older messages
 *     leave the window, so it is sized well above the busiest day, not at cost.
 *   - `session`: customer messages one conversation may send. Past it that
 *     conversation stops; « Nouvelle conversation » starts another.
 * EMPTY IS THE DEFAULT, not zero: a shop that never set a cap gets
 * CHAT_CAP_DEFAULTS. No environment variable (owner, 2026-11-02: « make these
 * internal … a number that can be changed »).
 * docs/decisions/storefront-advisor.md § The caps are numbers on the dashboard.
 */

export const CHAT_CAP_DEFAULTS = Object.freeze({ daily: 500, session: 40 });

/** Mirrored by the shops check constraints (00_baseline.test.mjs). */
export const CHAT_CAP_BOUNDS = Object.freeze({
  daily: Object.freeze({ min: 1, max: 100000 }),
  session: Object.freeze({ min: 1, max: 500 })
});

export const CHAT_CAP_COLUMNS = Object.freeze({ daily: 'storefront_chat_daily_cap', session: 'storefront_chat_session_cap' });

export const CHAT_CAP_KINDS = Object.freeze(['daily', 'session']);

/** `{ ok, value }`: a whole number within bounds, or null (empty: the default); else `{ ok: false, error }`. */
export function validateCap(kind, input) {
  const bounds = CHAT_CAP_BOUNDS[kind];
  if (!bounds) return { ok: false, error: `Unknown cap "${kind}".` };
  if (input === null || input === undefined || (typeof input === 'string' && input.trim() === '')) return { ok: true, value: null };
  const value = typeof input === 'string' ? Number(input.trim()) : input;
  if (typeof value !== 'number' || !Number.isInteger(value)) return { ok: false, error: `The ${kind} cap must be a whole number.` };
  if (value < bounds.min || value > bounds.max) return { ok: false, error: `The ${kind} cap must be between ${bounds.min} and ${bounds.max}.` };
  return { ok: true, value };
}

/** What applies: the stored number, else the default. A stored value outside bounds is ignored, never trusted. */
export function effectiveCaps(stored) {
  const pick = (kind) => {
    const checked = validateCap(kind, stored?.[kind]);
    return checked.ok && checked.value !== null ? checked.value : CHAT_CAP_DEFAULTS[kind];
  };
  return { daily: pick('daily'), session: pick('session') };
}

const COLUMNS = ['id', CHAT_CAP_COLUMNS.daily, CHAT_CAP_COLUMNS.session].join(',');

/** `{ shopId, daily, session }` as stored (null: not set) for one shop domain; null when the shop has no row. */
export async function readChatCaps(supabase, shopDomain) {
  const [row] = await supabaseSelect(supabase, T.SHOPS, { shop_domain: shopDomain }, COLUMNS, { limit: 1 });
  if (!row) return null;
  return { shopId: row.id, daily: row[CHAT_CAP_COLUMNS.daily] ?? null, session: row[CHAT_CAP_COLUMNS.session] ?? null };
}

/** Saves both caps for one shop domain, each validated (empty: back to the default). Returns what is stored. */
export async function saveChatCaps(supabase, shopDomain, input) {
  const daily = validateCap('daily', input?.daily);
  if (!daily.ok) return daily;
  const session = validateCap('session', input?.session);
  if (!session.ok) return session;
  const rows = await supabaseUpdate(
    supabase,
    T.SHOPS,
    { shop_domain: shopDomain },
    { [CHAT_CAP_COLUMNS.daily]: daily.value, [CHAT_CAP_COLUMNS.session]: session.value },
    { select: 'id' }
  );
  if (!rows?.length) return { ok: false, error: `No shop row for ${shopDomain}.` };
  return { ok: true, value: { daily: daily.value, session: session.value } };
}

/**
 * The caps the chat applies, per shop, read at most once a minute per server
 * instance: a message costs no extra round trip, and a change on the dashboard
 * reaches every instance within the minute. A failed read (the columns not yet
 * migrated, the database unreachable) answers the last value known, else the
 * defaults: a cap read must never take the chat down.
 *
 * @param {(shopDomain: string) => Promise<{ daily?: number | null, session?: number | null } | null>} read
 * @param {{ ttlMs?: number, now?: () => number, onError?: (error: unknown) => void }} [options]
 * @returns {(shopDomain: string) => Promise<{ daily: number, session: number }>}
 */
export function createChatCapsCache(read, { ttlMs = 60_000, now = () => Date.now(), onError = () => {} } = {}) {
  const cache = new Map();
  return async function capsFor(shopDomain) {
    const hit = cache.get(shopDomain);
    if (hit && now() - hit.at < ttlMs) return hit.caps;
    let caps;
    try {
      caps = effectiveCaps(await read(shopDomain));
    } catch (error) {
      onError(error);
      caps = hit?.caps ?? effectiveCaps(null);
    }
    cache.set(shopDomain, { at: now(), caps });
    return caps;
  };
}

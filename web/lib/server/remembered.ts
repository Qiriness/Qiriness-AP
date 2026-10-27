/**
 * A per-shop read kept for a few minutes on this server instance: what
 * `getShopByDomain` (./shop.ts) does for the shop row, for other small settings
 * read on nearly every request (marketplaces, the VIP rule).
 *
 * WHY. Each was read once per request, sometimes twice, and each read is a
 * logged REST request: on 2026-10-27 afternoon, `sales_channels` alone was 16%
 * of the dashboard's requests and the VIP rule 4% (log ingest is metered per
 * request). They change only when someone saves Setup, so a few minutes of
 * memory is invisible — and the save calls `forget`, so the instance that took
 * the save shows it at once; another instance catches up within the TTL.
 *
 * Concurrent requests share the read in flight. A failure, or an empty answer
 * the caller marks as not to keep, is never remembered: the next request asks.
 *
 * Server-only.
 */

export const REMEMBER_MS = 5 * 60 * 1000;

export function remembered<T>(load: (key: string) => Promise<T>, { ttlMs = REMEMBER_MS, keep = (_value: T) => true } = {}) {
  const entries = new Map<string, { at: number; value: Promise<T> }>();

  function read(key: string): Promise<T> {
    const hit = entries.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const entry = { at: Date.now(), value: load(key) };
    entries.set(key, entry);
    const drop = () => {
      if (entries.get(key) === entry) entries.delete(key);
    };
    entry.value.then((value) => {
      if (!keep(value)) drop();
    }, drop);
    return entry.value;
  }

  return { read, forget: (key: string) => void entries.delete(key) };
}

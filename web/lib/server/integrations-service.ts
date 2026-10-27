/**
 * Settings → Integrations: whether Klaviyo is connected, and saving or
 * removing its private key.
 *
 * THE KEY GOES ONE WAY. It arrives in a PUT, is checked against Klaviyo, and is
 * handed to `klaviyo_save_key` (Supabase Vault). Nothing here ever reads it
 * back: the browser is shown the last four characters and the last sync, and
 * only the sync (scripts/lib/klaviyo-sync.mjs) decrypts it.
 *
 * EVERY CALL NAMES ITS SHOP. Each shop has its own Klaviyo account, and the
 * caller resolves which one from the request (integration-shop.ts); there is
 * no default to fall back on.
 */

import {
  connectKlaviyo,
  disconnectKlaviyo,
  readKlaviyoConnection,
} from "../../../scripts/lib/klaviyo-sync.mjs";
import { getSupabaseClient } from "./insights/shared";

export interface KlaviyoStatus {
  connected: boolean;
  keyHint: string | null;
  savedAt: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: "ok" | "failed" | null;
  lastSyncError: string | null;
}

const DISCONNECTED: KlaviyoStatus = {
  connected: false,
  keyHint: null,
  savedAt: null,
  lastSyncAt: null,
  lastSyncStatus: null,
  lastSyncError: null,
};

export async function getKlaviyoStatus(shopId: string): Promise<KlaviyoStatus> {
  const row = await readKlaviyoConnection(getSupabaseClient(), shopId);
  if (!row) return DISCONNECTED;
  return {
    connected: true,
    keyHint: row.key_hint ?? null,
    savedAt: row.saved_at ?? null,
    lastSyncAt: row.last_sync_at ?? null,
    lastSyncStatus: row.last_sync_status ?? null,
    lastSyncError: row.last_sync_error ?? null,
  };
}

export async function saveKlaviyoKey(shopId: string, key: unknown, savedBy: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await connectKlaviyo({
    supabase: getSupabaseClient(),
    shopId,
    key,
    savedBy,
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

export async function removeKlaviyoKey(shopId: string): Promise<void> {
  await disconnectKlaviyo({ supabase: getSupabaseClient(), shopId });
}

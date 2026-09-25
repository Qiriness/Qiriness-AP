/**
 * Settings → Integrations: whether Klaviyo is connected, and saving or
 * removing its private key.
 *
 * THE KEY GOES ONE WAY. It arrives in a PUT, is checked against Klaviyo, and is
 * handed to `klaviyo_save_key` (Supabase Vault). Nothing here ever reads it
 * back: the browser is shown the last four characters and the last sync, and
 * only the sync (scripts/lib/klaviyo-sync.mjs) decrypts it.
 */

import {
  connectKlaviyo,
  disconnectKlaviyo,
  readKlaviyoConnection,
} from "../../../scripts/lib/klaviyo-sync.mjs";
import { getSupabaseClient } from "./insights/shared";
import { getShopId } from "./knowledge-service";

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

export async function getKlaviyoStatus(): Promise<KlaviyoStatus> {
  const row = await readKlaviyoConnection(getSupabaseClient(), await getShopId());
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

export async function saveKlaviyoKey(key: unknown, savedBy: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await connectKlaviyo({
    supabase: getSupabaseClient(),
    shopId: await getShopId(),
    key,
    savedBy,
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

export async function removeKlaviyoKey(): Promise<void> {
  await disconnectKlaviyo({ supabase: getSupabaseClient(), shopId: await getShopId() });
}

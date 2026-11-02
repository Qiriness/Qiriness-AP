import {
  CHAT_CAP_BOUNDS,
  CHAT_CAP_DEFAULTS,
  readChatCaps,
} from "../../../../scripts/lib/storefront-chat/chat-caps.mjs";
import { STOREFRONT_CHAT_RPC } from "../../../../scripts/lib/tables.mjs";
import { supabaseRpc } from "../../../../scripts/lib/supabase-rest-client.mjs";
import { getSupabaseClient } from "../insights/shared";

/** One advisor shop's caps as the dashboard shows them (chat-caps.mjs). */
export type ChatCapsView = {
  shopDomain: string;
  /** False when the shop has no `shops` row yet: nothing can be stored, the defaults apply. */
  storable: boolean;
  daily: number | null;
  session: number | null;
  defaults: { daily: number; session: number };
  bounds: { daily: { min: number; max: number }; session: { min: number; max: number } };
  /** Customer messages over the last 24 hours, what the daily cap is checked against; null when unreadable. */
  usedLast24h: number | null;
  /** The read failed (e.g. the columns are not migrated yet): shown, not editable. */
  error: boolean;
};

/**
 * The caps of each shop the advisor answers, with the 24-hour count the daily
 * cap is checked against, for the card on Storefront Agent → Dashboard. Read
 * fresh on every page view; the chat itself reads them at most once a minute.
 */
export async function getChatCaps(shops: string[]): Promise<ChatCapsView[]> {
  const db = getSupabaseClient();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return Promise.all(
    shops.map(async (shopDomain) => {
      const base = { shopDomain, defaults: { ...CHAT_CAP_DEFAULTS }, bounds: { daily: { ...CHAT_CAP_BOUNDS.daily }, session: { ...CHAT_CAP_BOUNDS.session } } };
      const [stored, used] = await Promise.all([
        readChatCaps(db, shopDomain).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => {
            console.warn("[storefront agent] caps unreadable", error instanceof Error ? error.message : error);
            return { ok: false as const, value: null };
          },
        ),
        supabaseRpc(db, STOREFRONT_CHAT_RPC.USER_MESSAGES_SINCE, { p_shop_domain: shopDomain, p_since: since }).then(
          (n: unknown) => (Number.isFinite(Number(n)) ? Number(n) : null),
          () => null,
        ),
      ]);
      return {
        ...base,
        storable: Boolean(stored.ok && stored.value),
        daily: stored.value?.daily ?? null,
        session: stored.value?.session ?? null,
        usedLast24h: used,
        error: !stored.ok,
      };
    }),
  );
}

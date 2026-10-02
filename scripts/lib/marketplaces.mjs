import { supabaseSelect } from './supabase-rest-client.mjs';
import { T } from './tables.mjs';

// THE MARKETPLACES THIS SHOP SELLS ON, from `sales_channels`.
//
// Replaces `MARKETPLACE_CHANNELS`, `ALL_MARKETPLACE_HANDLES` and `PLATFORMS`,
// constants in insights-range.mjs that named this shop's two marketplaces
// (Amazon, and Yves Rocher as the Mirakl Connect channel `connect-dev-1`).
//
// A BUSINESS JUDGEMENT, SO IT IS THE MERCHANT'S. Which channel handles make up
// a marketplace is not something the orders say: Yves Rocher is not a handle at
// all, it is a Mirakl channel. The shop's own store is defined as every handle
// that is NOT a marketplace (the online store, draft orders, the Shop app), so a
// new first-party channel lands in Shopify rather than in nothing.
//
// One object per read, passed to whatever needs it. No module state: the web
// and the worker each load it where they already load the shop.

export const ALL_PLATFORM = 'all';
export const SHOPIFY_PLATFORM = 'shopify';
export const DEFAULT_PLATFORM = ALL_PLATFORM;

/**
 * @param rows `sales_channels` rows: { platform_key, label, handles, analytics_names, position }
 */
export function buildMarketplaces(rows = []) {
  const list = (Array.isArray(rows) ? rows : [])
    .filter((row) => row?.platform_key && row.platform_key !== ALL_PLATFORM && row.platform_key !== SHOPIFY_PLATFORM)
    .map((row) => ({
      key: String(row.platform_key),
      label: String(row.label || row.platform_key),
      handles: [...new Set((row.handles || []).map((h) => String(h).trim()).filter(Boolean))],
      analyticsNames: [...new Set((row.analytics_names || []).map((h) => String(h).trim().toLowerCase()).filter(Boolean))],
      position: Number(row.position) || 0
    }))
    .sort((a, b) => a.position - b.position || a.label.localeCompare(b.label));

  const byKey = new Map(list.map((m) => [m.key, m]));
  const handles = Object.freeze([...new Set(list.flatMap((m) => m.handles))]);

  return {
    /** The marketplaces, in display order: [{ key, label, handles }]. */
    list,
    /** Every marketplace handle. The shop's own store is everything else. */
    handles,
    /** The filter's choices: all, the shop's store, then each marketplace. */
    platforms: [
      { id: ALL_PLATFORM, label: 'All platforms' },
      { id: SHOPIFY_PLATFORM, label: 'Shopify' },
      ...list.map((m) => ({ id: m.key, label: m.label }))
    ],
    /** Their names, for a sentence: « Amazon et Yves Rocher ». Empty when none. */
    names: list.map((m) => m.label),

    /** True for a platform whose buyers are minted one customer per order. */
    isMarketplace(platform) {
      return byKey.has(platform);
    },

    /** The channel arguments the ranged SQL functions take, for one platform. */
    channelFilter(platform) {
      if (byKey.has(platform)) return { channels: [...byKey.get(platform).handles], notChannels: null };
      if (platform === SHOPIFY_PLATFORM) return { channels: null, notChannels: [...handles] };
      return { channels: null, notChannels: null };
    },

    /** The platform a channel handle belongs to: a marketplace's key, or `shopify`. */
    platformOfChannel(handle) {
      for (const m of list) {
        if (m.handles.includes(handle)) return m.key;
      }
      return SHOPIFY_PLATFORM;
    },

    /** The platform a Shopify Analytics `sales_channel` name belongs to. */
    platformOfAnalyticsChannel(channel) {
      const name = String(channel ?? '').trim().toLowerCase();
      for (const m of list) {
        if (m.analyticsNames.includes(name)) return m.key;
      }
      return SHOPIFY_PLATFORM;
    },

    /** A platform from a URL, or the default when it names nothing this shop has. */
    parsePlatform(value) {
      return value === ALL_PLATFORM || value === SHOPIFY_PLATFORM || byKey.has(value) ? value : DEFAULT_PLATFORM;
    },

    labelOf(platform) {
      return this.platforms.find((p) => p.id === platform)?.label ?? platform;
    }
  };
}

/** A shop that sells on no marketplace: every order is its own store's. */
export const NO_MARKETPLACES = buildMarketplaces([]);

export async function loadMarketplaces(supabase, shopId) {
  const rows = await supabaseSelect(
    supabase,
    T.SALES_CHANNELS,
    { shop_id: shopId },
    'platform_key,label,handles,analytics_names,position',
    { order: 'position.asc' }
  );
  return buildMarketplaces(rows);
}

/**
 * The names joined for a sentence, in the reader's language: « Amazon and Yves
 * Rocher », « Amazon et Yves Rocher ». A shop with none gets the generic word.
 */
export function marketplaceNames(marketplaces, locale = 'en') {
  const names = marketplaces?.names ?? [];
  if (names.length === 0) return locale === 'fr' ? 'les marketplaces' : 'the marketplaces';
  try {
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(names);
  } catch {
    return names.join(', ');
  }
}

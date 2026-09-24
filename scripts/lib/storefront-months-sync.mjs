import { isValidTimeZone, wallClock } from './insights-range.mjs';
import { askShopifyql } from './shopifyql-client.mjs';
import { monthDrift, readSessionMonths, sessionMonthsQuery, storedSpan } from './storefront-months.mjs';
import { supabaseSelectAll, supabaseUpsert } from './supabase-rest-client.mjs';
import { STOREFRONT_T } from './tables.mjs';

/**
 * Rewrite every closed month of storefront sessions the dashboard reads from
 * Supabase — see storefront-months.mjs for why they are stored at all.
 *
 * EVERY NIGHT, EVERY STORED MONTH, NOT JUST THE ONE THAT CLOSED. It is one
 * ShopifyQL query whatever the span (cost is capped at the bucket's 1,000), so
 * rewriting three years costs what adding one month would. That buys two
 * things a run-on-the-1st could not: a missed night heals itself the next
 * night, and a closed month Shopify restates is corrected and REPORTED — the
 * drift list is the check on whether two live months is enough.
 *
 * The shop's clock decides where a month starts, as it does for ShopifyQL's
 * own month buckets. Money is never written: net sales and AOV are always live.
 */
export async function runStorefrontMonthsSync({ shopify, supabase, shopRow, dryRun = false, now = new Date(), log = console.log }) {
  const tz = isValidTimeZone(shopRow.iana_timezone) ? shopRow.iana_timezone : 'UTC';
  const span = storedSpan(wallClock(now, tz));
  const rows = readSessionMonths(
    await askShopifyql(shopify, sessionMonthsQuery(span), { log }),
    shopRow.id
  ).filter((row) => `${row.month}T00:00:00` >= span.from && `${row.month}T00:00:00` < span.to);

  const before = await supabaseSelectAll(
    supabase,
    STOREFRONT_T.SESSION_MONTHS,
    { shop_id: shopRow.id },
    'month,sessions,pageviews,cart_sessions,checkout_sessions,converted_sessions',
    { order: 'month.asc' }
  );
  const drift = monthDrift(before, rows);
  for (const change of drift) {
    log(`Storefront month ${change.month} restated by Shopify: ${change.fields.join(', ')} (sessions ${change.before} -> ${change.after})`);
  }

  if (!dryRun && rows.length > 0) {
    const fetchedAt = now.toISOString();
    await supabaseUpsert(
      supabase,
      STOREFRONT_T.SESSION_MONTHS,
      rows.map((row) => ({ ...row, fetched_at: fetchedAt })),
      'shop_id,month'
    );
  }
  return { months: rows.length, restated: drift.length, from: span.from.slice(0, 7), to: span.to.slice(0, 7) };
}

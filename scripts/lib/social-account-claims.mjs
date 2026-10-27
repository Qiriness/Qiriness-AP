import { supabaseSelect } from './supabase-rest-client.mjs';
import { SOCIAL_T } from './tables.mjs';

/**
 * ONE ACCOUNT COUNTS FOR ONE SHOP.
 *
 * Several shops share the dashboard, and an agency or group login sees every
 * brand's pages and ad accounts: Qiriness's Meta login already lists
 * Barbara Gould's ad account (2026-10-27). `social_accounts.enabled` defaults
 * to true, so connecting a second shop with that login would start counting the
 * first shop's page, Instagram and ad spend in the second shop's Insights —
 * plausible figures that fail nothing.
 *
 * So an account another shop already tracks (same kind, same provider id,
 * `enabled`) is discovered switched OFF here, and switching it on here is
 * refused until the other shop switches it off. An account nobody tracks
 * behaves as before. docs/decisions/insights.md § Connections belong to one shop.
 */

const claimKey = (kind, externalId) => `${kind}:${externalId}`;

/**
 * Of `accounts` (`{kind, external_id}`), the ones a shop other than `shopId`
 * tracks: a Set of `kind:external_id`.
 */
export async function trackedElsewhere(supabase, shopId, accounts) {
  const ids = [...new Set(accounts.map((a) => String(a.external_id)))];
  if (ids.length === 0) return new Set();
  const rows = await supabaseSelect(
    supabase,
    SOCIAL_T.ACCOUNTS,
    { shop_id: { operator: 'neq', value: shopId }, enabled: true, external_id: { operator: 'in', value: `(${ids.map(quote).join(',')})` } },
    'kind,external_id',
    { limit: 1000 }
  );
  return new Set(rows.map((r) => claimKey(r.kind, r.external_id)));
}

/** Whether another shop tracks this account. */
export function isClaimed(claimed, account) {
  return claimed.has(claimKey(account.kind, String(account.external_id)));
}

// A PostgREST `in` list item, quoted so an id with a comma or a dot stays one item.
function quote(value) {
  return `"${value.replace(/["\\]/g, (c) => `\\${c}`)}"`;
}

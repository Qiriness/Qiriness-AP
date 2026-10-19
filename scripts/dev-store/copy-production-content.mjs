/**
 * DEV STORE ONLY. The dev store's products are copies of production's without
 * their content metafields (ingredients, benefits, usage, ratings): on
 * 2026-10-18, 3 to 8 of its 51 active products had them, production all 51.
 * The routine cards show that content (owner, 2026-10-18), so after each dev
 * sync every dev product row missing a piece takes it from the production row
 * with the same handle. In Supabase only: the dev store itself is not written
 * (the advisor app has read scopes only), and production rows are only read.
 *
 * Only empty fields are filled, so content added on the dev store wins.
 */

import { supabaseSelect, supabaseSelectAll, supabaseUpdate } from '../lib/supabase-rest-client.mjs';
import { CONTENT_METAFIELDS } from '../lib/storefront-chat/product-repository.mjs';

const TEXT_COLUMNS = ['short_description', 'active_ingredients', 'usage_instructions', 'usage_advice'];
const METAFIELD_KEYS = [...new Set(Object.values(CONTENT_METAFIELDS).flat())];

const empty = (v) => v === null || v === undefined || (typeof v === 'string' && (!v.trim() || v.trim() === 'null')) || (Array.isArray(v) && !v.length);

/** The fields of `prod` a dev row lacks: the text columns, and the content metafields merged in. */
export function contentPatch(dev, prod) {
  const patch = {};
  for (const column of TEXT_COLUMNS) if (empty(dev[column]) && !empty(prod[column])) patch[column] = prod[column];
  const devFields = dev.structured_facts?.metafields ?? {};
  const prodFields = prod.structured_facts?.metafields ?? {};
  const added = Object.fromEntries(METAFIELD_KEYS.filter((k) => !devFields[k] && prodFields[k]).map((k) => [k, prodFields[k]]));
  if (Object.keys(added).length) patch.structured_facts = { ...(dev.structured_facts ?? {}), metafields: { ...devFields, ...added } };
  return patch;
}

export async function copyProductionContent(supabase, devShopId, { dryRun = false } = {}) {
  const [prodShop] = await supabaseSelect(supabase, 'shops', { environment: 'production' }, 'id', { limit: 1 });
  if (!prodShop) return { updated: 0, reason: 'no production shop' };
  const columns = ['id', 'handle', 'structured_facts', ...TEXT_COLUMNS].join(',');
  const [devRows, prodRows] = await Promise.all([
    supabaseSelectAll(supabase, 'products', { shop_id: devShopId }, columns),
    supabaseSelectAll(supabase, 'products', { shop_id: prodShop.id }, columns)
  ]);
  const byHandle = new Map(prodRows.map((r) => [r.handle, r]));
  let updated = 0;
  for (const dev of devRows) {
    const prod = byHandle.get(dev.handle);
    if (!prod) continue;
    const patch = contentPatch(dev, prod);
    if (!Object.keys(patch).length) continue;
    updated++;
    if (!dryRun) await supabaseUpdate(supabase, 'products', { id: dev.id }, patch, { returning: 'minimal' });
  }
  return { updated, of: devRows.length };
}

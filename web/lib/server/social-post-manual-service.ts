import 'server-only';
import { supabaseSelectAll, supabaseSelect, supabaseUpsert, supabaseDelete } from '../../../scripts/lib/supabase-rest-client.mjs';
import { checkManualMetric } from '../../../scripts/lib/social-post-manual.mjs';
import { getSupabaseClient } from './insights/shared';
import { getShopId } from './knowledge-service';
export { checkManualMetric } from '../../../scripts/lib/social-post-manual.mjs';
export interface ManualPostEntry { account_id: string; post_id: string; metric: string; value: number; basis: string | null }
const TABLE = 'social_post_manual_metrics';
export async function readManualPosts(shopId: string): Promise<Map<string, ManualPostEntry[]>> {
  const rows = await supabaseSelectAll(getSupabaseClient(), TABLE, { shop_id: shopId }, 'account_id,post_id,metric,value,basis', { order: 'account_id.asc,post_id.asc,metric.asc' }) as ManualPostEntry[];
  const result = new Map<string, ManualPostEntry[]>();
  for (const row of rows) { const key = `${row.account_id}|${row.post_id}`; result.set(key, [...(result.get(key) ?? []), row]); }
  return result;
}
export async function setManualPost(accountId: string, postId: string, metric: string, value: number | null) {
  const shopId = await getShopId();
  const client = getSupabaseClient();
  const [post] = await supabaseSelect(client, 'social_posts', { shop_id: shopId, account_id: accountId, external_id: postId }, 'views,reach,engagement,likes,comments,shares,follows', { limit: 1 });
  if (!post) return false;
  if (value !== null && metric in post && post[metric] !== null) throw new Error('The platform already reports this metric');
  const filters = { shop_id: shopId, account_id: accountId, post_id: postId, metric };
  if (value === null) await supabaseDelete(client, TABLE, filters);
  else {
    const [account] = await supabaseSelect(client, 'social_accounts', { shop_id: shopId, id: accountId }, 'engagement_basis', { limit: 1 });
    await supabaseUpsert(client, TABLE, [{ ...filters, value, basis: metric === 'engagementRate' ? account.engagement_basis ?? 'reach' : null, updated_at: new Date().toISOString() }], 'shop_id,account_id,post_id,metric');
  }
  return true;
}
export function checkPercent(value: unknown) {
  const checked = checkManualMetric('nonFollowersPct', value ?? null);
  return checked.ok ? { ok: true as const, percent: checked.value as number | null } : { ok: false as const, error: checked.error as string };
}
export const setNonFollowers = (accountId: string, postId: string, percent: number | null) => setManualPost(accountId, postId, 'nonFollowersPct', percent);

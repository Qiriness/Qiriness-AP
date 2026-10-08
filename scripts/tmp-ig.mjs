import { loadConfig, loadEnv } from './lib/sync-config.mjs';
import { createSupabaseClient, supabaseRpc, supabaseSelect } from './lib/supabase-rest-client.mjs';
const config = loadConfig(loadEnv());
const sb = createSupabaseClient(config);
const [shop] = await supabaseSelect(sb, 'shops', { shop_domain: config.shopDomain }, 'id', { limit: 1 });
const token = await supabaseRpc(sb, 'social_read_token', { p_shop: shop.id, p_provider: 'meta' });
const g = async (path, params) => { const u = new URL(`https://graph.facebook.com/${params.v ?? 'v23.0'}/${path}`); for (const [k, v] of Object.entries(params)) if (k !== 'v') u.searchParams.set(k, v); u.searchParams.set('access_token', token); return (await fetch(u)).json(); };
const pages = await g('me/accounts', { fields: 'instagram_business_account{id}' });
const ig = pages.data.find((p) => p.instagram_business_account).instagram_business_account.id;
const media = await g(`${ig}/media`, { fields: 'id,media_product_type,media_type,timestamp', limit: '10' });
const m = media.data.find((x) => x.media_product_type === 'REELS') ?? media.data[0];
const f = media.data.find((x) => x.media_product_type === 'FEED');
const show = (r) => r.error ? `ERR ${r.error.code}/${r.error.error_subcode ?? ''}: ${r.error.message.slice(0, 160)}` : JSON.stringify(r.data).slice(0, 420);
const combos = [
  { metric: 'reach', breakdown: 'follow_type', period: 'lifetime' },
  { metric: 'reach', breakdown: 'follow_type', period: 'lifetime', metric_type: 'total_value' },
  { metric: 'views', breakdown: 'follow_type', period: 'lifetime' },
  { metric: 'views', breakdown: 'follow_type', period: 'lifetime', metric_type: 'total_value' },
  { metric: 'reach', breakdown: 'follower_type', period: 'lifetime' },
  { metric: 'views', breakdown: 'is_from_followers', period: 'lifetime' },
  { metric: 'views', breakdown: 'follow_type', period: 'lifetime', v: 'v21.0' },
  { metric: 'reach', breakdown: 'follow_type', period: 'lifetime', v: 'v25.0' },
];
for (const media of [m, f]) {
  console.log(media.media_product_type, media.id);
  for (const c of combos) console.log('  ', JSON.stringify(c), '->', show(await g(`${media.id}/insights`, c)));
}

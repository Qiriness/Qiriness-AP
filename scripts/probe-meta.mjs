import { loadConfig, loadEnv } from './lib/sync-config.mjs';
import { createMetaClient } from './lib/meta-client.mjs';
import { META_METRICS } from './lib/meta-insights.mjs';
import { socialAppConfig } from './lib/social-oauth.mjs';
import { createSupabaseClient, supabaseRpc, supabaseSelect } from './lib/supabase-rest-client.mjs';
import { SOCIAL_RPC, T } from './lib/tables.mjs';

// Which of the metric names in META_METRICS does Meta still answer, for the
// accounts this shop has connected?
//
//   npm run probe:meta
//
// WHY. Meta retires insight metrics with each Graph API version, and a retired
// name is skipped by the sync and recorded as not measured — the panel shows a
// dash. This prints, per metric, answered or refused, so a name to change in
// meta-insights.mjs is found here rather than read off an empty card.
//
// READ-ONLY: one yesterday-sized request per metric. Nothing is written. Values
// are not printed, only whether each metric answered.

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const env = loadEnv();
  const config = loadConfig(env);
  const app = socialAppConfig(env).meta;
  if (!app.canSync) throw new Error(`Meta app credentials missing: ${app.missing.join(', ')}`);

  const supabase = createSupabaseClient(config);
  const [shop] = (await supabaseSelect(supabase, T.SHOPS, { shop_domain: config.shopDomain }, 'id', { limit: 1 })) ?? [];
  if (!shop) throw new Error(`No shop row for ${config.shopDomain}. Run a sync first.`);
  const token = await supabaseRpc(supabase, SOCIAL_RPC.READ_TOKEN, { p_shop: shop.id, p_provider: 'meta' });
  if (!token) throw new Error('Meta is not connected for this shop. Connect it from Insights → Social media → Connections.');

  const meta = createMetaClient({ token, appSecret: app.appSecret, graphVersion: app.graphVersion });
  console.log(`Graph API ${app.graphVersion}\nGranted: ${(await meta.grantedScopes()).join(', ')}\n`);

  const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const unix = (day) => Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);

  for (const page of await meta.listPages()) {
    console.log(`Facebook Page « ${page.name} »`);
    await report(meta, page.id, Object.keys(META_METRICS.facebookDay), { period: 'day', since: yesterday, until: today }, page.access_token);
    await report(meta, page.id, Object.keys(META_METRICS.facebookUnique), { period: 'day', since: yesterday, until: today }, page.access_token);
    const [post] = await meta.pagePosts(page.id, page.access_token, null).then((p) => p.slice(0, 1)).catch(() => []);
    if (post) await report(meta, post.id, Object.keys(META_METRICS.facebookPost), { period: 'lifetime' }, page.access_token, 'latest post');

    const ig = page.instagram_business_account;
    if (!ig?.id) continue;
    console.log(`\nInstagram @${ig.username ?? ig.id}`);
    const day = { period: 'day', metric_type: 'total_value', since: unix(yesterday), until: unix(today) };
    await report(meta, ig.id, Object.keys(META_METRICS.instagramDay), day);
    await report(meta, ig.id, [META_METRICS.instagramFollows.metric], { ...day, breakdown: META_METRICS.instagramFollows.breakdown });
    await report(meta, ig.id, Object.keys(META_METRICS.instagramUnique), day);
    for (const breakdown of META_METRICS.instagramAudience.breakdowns) {
      await report(meta, ig.id, [META_METRICS.instagramAudience.metric], { period: 'lifetime', metric_type: 'total_value', timeframe: META_METRICS.instagramAudience.timeframe, breakdown }, undefined, breakdown);
    }
    const media = await meta.request(`${ig.id}/media`, { fields: 'id,media_product_type', limit: 5 });
    for (const item of media?.data ?? []) {
      await report(meta, item.id, META_METRICS.instagramMedia, {}, undefined, `${item.media_product_type} post`);
    }
    console.log('');
  }

  const adAccounts = await meta.listAdAccounts();
  console.log(`Ad accounts: ${adAccounts.map((a) => `${a.name} (${a.currency})`).join(', ') || 'none'}`);
}

async function report(meta, objectId, metrics, params, asToken, label = '') {
  try {
    const { data, failed } = await meta.insights(objectId, metrics, params, { asToken });
    const answered = new Set(data.map((d) => d.name));
    for (const metric of metrics) {
      const mark = failed.includes(metric) ? 'REFUSED ' : answered.has(metric) ? 'answered' : 'empty   ';
      console.log(`  ${mark}  ${metric}${label ? `  (${label})` : ''}`);
    }
  } catch (error) {
    console.log(`  ERROR     ${metrics.join(', ')}${label ? `  (${label})` : ''}: ${error.message}`);
  }
}

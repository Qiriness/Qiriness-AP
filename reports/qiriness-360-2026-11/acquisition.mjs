// Acquisition source per order, read-only, Qiriness only.
//
//   node reports/qiriness-360-2026-11/acquisition.mjs
//
// 1. Reads the qualifying DTC orders (same population as sql/_base.sqlinc) over a read-only DB session.
// 2. Asks Shopify (Admin GraphQL, qiriness.myshopify.com only) for each order's customerJourneySummary.
//    Cached in the scratchpad dir given by ACQ_CACHE (order gid -> source fields; no names, emails or URLs' query strings).
// 3. Writes AGGREGATES only to data/acq_*.csv.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from '../../node_modules/pg/lib/index.js';
import { loadEnv, loadConfig } from '../../scripts/lib/sync-config.mjs';
import { createShopifyClient, shopifyGraphql } from '../../scripts/lib/shopify-admin-client.mjs';
import { QIRINESS_SHOP_ID, checkStatement } from './run.mjs';

pg.types.setTypeParser(1082, (v) => v);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const env = loadEnv(root);
const config = loadConfig(env);
if (config.shopDomain !== 'qiriness.myshopify.com') throw new Error(`refused: shop domain is ${config.shopDomain}`);

const cacheFile = process.env.ACQ_CACHE || path.join(here, '.acq-cache.json');
const base = fs.readFileSync(path.join(here, 'sql', '_base.sqlinc'), 'utf8').replace(/^--.*$/gm, '').trim();

const ORDERS_SQL = `with ${base},
x as (select b.id, b.cid, b.seq, b.legacy, b.ts, b.m, b.net_ht, b.has_promo, b.has_code,
        (select min(ts) from bo y where y.cid=b.cid and y.seq=2) t2,
        (select coalesce(sum(net_ht),0) from bo y where y.cid=b.cid and y.ts < b.ts + interval '180 days') v180
      from bo b)
select o.shopify_order_id gid, x.seq, x.legacy, to_char(x.m,'YYYY-MM') m, x.net_ht::float net_ht, x.has_promo, x.has_code,
  (x.ts < timestamptz '2026-05-05 00:00 Europe/Paris') matured180,
  (x.t2 is not null and x.t2 < x.ts + interval '180 days') second_180, x.v180::float v180,
  md5(x.cid::text) pid
from x join orders o on o.id = x.id and o.shop_id = :shop`;

const JOURNEY = `#graphql
query Journeys($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Order {
      id
      customerJourneySummary {
        ready
        daysToConversion
        momentsCount { count }
        firstVisit { source sourceType referrerUrl landingPage utmParameters { source medium campaign } }
        lastVisit { source sourceType referrerUrl landingPage utmParameters { source medium campaign } }
      }
    }
  }
}`;

function stripUrl(u) {
  if (!u) return null;
  try { const x = new URL(u); return x.hostname + x.pathname; } catch { return String(u).split('?')[0]; }
}

function visit(v) {
  if (!v) return null;
  return {
    source: v.source || null, sourceType: v.sourceType || null,
    referrer: v.referrerUrl ? stripUrl(v.referrerUrl).split('/')[0] : null,
    landing: v.landingPage ? stripUrl(v.landingPage).replace(/^[^/]+/, '') : null,
    utmSource: v.utmParameters?.source || null, utmMedium: v.utmParameters?.medium || null, utmCampaign: v.utmParameters?.campaign || null,
  };
}

export function channelOf(v) {
  if (!v) return 'Unknown (no journey)';
  const s = `${v.utmSource || ''} ${v.source || ''} ${v.referrer || ''}`.toLowerCase();
  const med = (v.utmMedium || '').toLowerCase();
  const type = (v.sourceType || '').toUpperCase();
  if (/klaviyo|newsletter/.test(s) || med === 'email') return 'Email (Klaviyo)';
  if (/(facebook|instagram|\bfb\b|\big\b|meta|tiktok|pinterest)/.test(s)) {
    return /(paid|cpc|ads|ppc|cpm)/.test(med) || /ads|paid/.test(s) ? 'Paid social' : 'Social (organic/unknown)';
  }
  if (med === 'product_sync') return 'Google Shopping (free listings)';
  if (/google|bing|yahoo|ecosia|qwant|duckduckgo/.test(s)) {
    return /(cpc|ppc|paid)/.test(med) || /shopping|pmax|ads/.test(s) ? 'Paid search / Shopping' : 'Search (organic)';
  }
  if (type === 'SEARCH') return 'Search (organic)';
  if (type === 'SOCIAL') return 'Social (organic/unknown)';
  if (type === 'EMAIL') return 'Email (Klaviyo)';
  if (/shop\.app|shop app/.test(s)) return 'Shop app';
  if (/chatgpt|openai|perplexity|copilot|gemini/.test(s)) return 'AI assistants';
  if (v.utmSource || med) return 'Other tagged';
  if ((v.source || '').toLowerCase() === 'direct' || /qiriness\./.test(v.referrer || '')) return 'Direct / untracked';
  if (v.referrer) return 'Referral';
  if (/direct/.test(s) || (!v.referrer && !v.utmSource)) return 'Direct / untracked';
  return 'Other';
}

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (x) => (x === null || x === undefined ? '' : /[",\n]/.test(String(x)) ? `"${String(x).replace(/"/g, '""')}"` : String(x));
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

async function loadOrders() {
  checkStatement('acquisition/orders', ORDERS_SQL);
  const client = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query('begin read only');
    await client.query("set local statement_timeout = '180s'");
    await client.query("set local timezone = 'Europe/Paris'");
    const r = await client.query(ORDERS_SQL.replaceAll(':shop', `'${QIRINESS_SHOP_ID}'::uuid`));
    return r.rows;
  } finally {
    await client.query('rollback').catch(() => {});
    await client.end();
  }
}

async function fetchJourneys(gids) {
  const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
  const todo = gids.filter((g) => !(g in cache));
  const shopify = await createShopifyClient(config);
  for (let i = 0; i < todo.length; i += 50) {
    const ids = todo.slice(i, i + 50);
    const data = await shopifyGraphql(shopify, JOURNEY, { ids });
    for (const n of data.nodes || []) {
      if (!n?.id) continue;
      const j = n.customerJourneySummary;
      cache[n.id] = j ? { ready: j.ready, days: j.daysToConversion, moments: j.momentsCount?.count ?? null,
        first: visit(j.firstVisit), last: visit(j.lastVisit) } : null;
    }
    for (const g of ids) if (!(g in cache)) cache[g] = null;
    if ((i / 50) % 10 === 0) { fs.writeFileSync(cacheFile, JSON.stringify(cache)); console.log(`journeys ${i + ids.length}/${todo.length}`); }
  }
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  return cache;
}

function group(rows, keyFn, agg) {
  const m = new Map();
  for (const r of rows) { const k = keyFn(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return [...m.entries()].map(([k, rs]) => ({ ...(typeof k === 'string' ? JSON.parse(k) : k), ...agg(rs) }));
}
const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
const avg = (xs) => (xs.length ? Math.round((100 * xs.reduce((s, x) => s + x, 0)) / xs.length) / 100 : null);

async function main() {
  const orders = await loadOrders();
  console.log(`orders ${orders.length}`);
  const cache = await fetchJourneys(orders.map((o) => o.gid));
  for (const o of orders) {
    o.seq = Number(o.seq);
    const j = cache[o.gid];
    o.first_channel = channelOf(j?.first);
    o.last_channel = channelOf(j?.last);
    o.has_journey = !!(j && (j.first || j.last));
    o.utm_campaign = j?.first?.utmCampaign || j?.last?.utmCampaign || null;
    o.landing = j?.first?.landing || null;
  }
  const out = path.join(here, 'data');
  const firsts = orders.filter((o) => o.seq === 1);

  const byChannel = group(firsts, (o) => JSON.stringify({ ctype: o.legacy ? 'legacy' : 'new', first_touch_channel: o.first_channel }), (rs) => {
    const mat = rs.filter((r) => r.matured180);
    return { customers: rs.length, first_aov_ht: avg(rs.map((r) => r.net_ht)), pct_first_on_promo: pct(rs.filter((r) => r.has_promo).length, rs.length),
      matured_180: mat.length, pct_2nd_180d: pct(mat.filter((r) => r.second_180).length, mat.length), value_180d: avg(mat.map((r) => r.v180)) };
  }).sort((a, b) => a.ctype.localeCompare(b.ctype) || b.customers - a.customers);
  fs.writeFileSync(path.join(out, 'acq_first_orders_by_channel.csv'), toCsv(byChannel));

  const byLast = group(orders, (o) => JSON.stringify({ order_type: o.seq === 1 ? (o.legacy ? 'first (legacy)' : 'first (new)') : 'repeat', last_touch_channel: o.last_channel }),
    (rs) => ({ orders: rs.length, net_ht: Math.round(rs.reduce((s, r) => s + r.net_ht, 0)), aov_ht: avg(rs.map((r) => r.net_ht)) }))
    .sort((a, b) => a.order_type.localeCompare(b.order_type) || b.orders - a.orders);
  fs.writeFileSync(path.join(out, 'acq_orders_by_last_touch.csv'), toCsv(byLast));

  const byMonth = group(firsts.filter((o) => !o.legacy), (o) => JSON.stringify({ m: o.m, first_touch_channel: o.first_channel }),
    (rs) => ({ new_customers: rs.length, net_ht: Math.round(rs.reduce((s, r) => s + r.net_ht, 0)) })).sort((a, b) => a.m.localeCompare(b.m) || b.new_customers - a.new_customers);
  fs.writeFileSync(path.join(out, 'acq_new_by_month_channel.csv'), toCsv(byMonth));

  const camp = group(firsts.filter((o) => !o.legacy && o.utm_campaign), (o) => JSON.stringify({ utm_campaign: o.utm_campaign.toLowerCase(), channel: o.first_channel }),
    (rs) => ({ new_customers: rs.length, first_aov_ht: avg(rs.map((r) => r.net_ht)) })).filter((r) => r.new_customers >= 5).sort((a, b) => b.new_customers - a.new_customers);
  fs.writeFileSync(path.join(out, 'acq_new_by_utm_campaign.csv'), toCsv(camp));

  const landing = group(firsts.filter((o) => !o.legacy), (o) => JSON.stringify({ landing_type: !o.landing ? '(unknown)' : o.landing.replace(/^\/(fr|en|it|de|nl|es)(\/|$)/, '/').split('/')[1] || '(home)' }),
    (rs) => { const mat = rs.filter((r) => r.matured180); return { new_customers: rs.length, first_aov_ht: avg(rs.map((r) => r.net_ht)), pct_2nd_180d: pct(mat.filter((r) => r.second_180).length, mat.length) }; })
    .sort((a, b) => b.new_customers - a.new_customers);
  fs.writeFileSync(path.join(out, 'acq_new_by_landing_type.csv'), toCsv(landing));

  const cov = group(orders, (o) => JSON.stringify({ m: o.m }), (rs) => ({ orders: rs.length, pct_with_journey: pct(rs.filter((r) => r.has_journey).length, rs.length) }))
    .sort((a, b) => a.m.localeCompare(b.m));
  fs.writeFileSync(path.join(out, 'acq_journey_coverage.csv'), toCsv(cov));
  console.log('written acq_*.csv');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}

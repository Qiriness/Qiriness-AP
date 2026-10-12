// Read-only: fingerprints what every analytics function returns, so a rewrite can
// be proven to change no figure.
//
//   node scripts/db-fingerprint.mjs <out.json>             record
//   node scripts/db-fingerprint.mjs <out.json> <before.json>  record and compare
//
// Calls every public insights_* / orders_* / vip_* / customer_* / open_orders /
// order_number_range function with arguments built from its PARAMETER NAMES and
// this shop's own data (timezone, marketplace handles, VIP rule, a real product
// and country), over several variants per function. Records a row count and a
// sha256 of the rows (sorted, so an unordered result compares equal) — never the
// rows themselves, so nothing personal or commercial is written or printed.
//
// Compare only fingerprints taken while the data is not moving (no sync, no
// worker), or against the same moment: a new order changes honest output too.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';

import { loadEnv } from './lib/sync-config.mjs';

const FUNCTIONS = /^(insights_|orders_list|vip_|customer_vip_|customer_segment_find|open_orders|order_number_range)/;

// --prelude <file.sql>: run that SQL first, in the same transaction, and ROLL BACK
// at the end. Fingerprints a candidate rewrite against live data while nothing
// it creates ever commits.
const args = process.argv.slice(2);
const preludeAt = args.indexOf('--prelude');
const prelude = preludeAt >= 0 ? readFileSync(args.splice(preludeAt, 2)[1], 'utf8') : null;
const [outFile, beforeFile] = args;
if (!outFile) {
  console.error('Usage: node scripts/db-fingerprint.mjs <out.json> [before.json] [--prelude candidate.sql]');
  process.exit(1);
}

const env = loadEnv();
const client = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
if (prelude) {
  await client.query('begin');
  await client.query(prelude);
  console.log('prelude applied inside the transaction; it will be rolled back');
} else {
  await client.query('begin read only');
}

const one = async (sql, params = []) => (await client.query(sql, params)).rows[0] ?? {};
const shop = await one(`select id, iana_timezone, vip_min_spend, vip_min_orders, vip_window_months
  from shops where id = (select shop_id from orders group by 1 order by count(*) desc limit 1)`);
const marketplaces = (await one(`select coalesce(array_agg(h), '{}') hs from sales_channels c cross join lateral unnest(c.handles) h where c.shop_id = $1`, [shop.id])).hs;
const product = (await one(`select li.value ->> 'product_id' id from orders o cross join lateral jsonb_array_elements(o.line_items) li
  where o.shop_id = $1 group by 1 order by count(*) desc limit 1`, [shop.id])).id;
const country = (await one(`select shipping_destination ->> 'country_code' c from orders where shop_id = $1 group by 1 order by count(*) desc limit 1`, [shop.id])).c;
const span = await one(`select min(processed_at) lo, now() hi from orders where shop_id = $1`, [shop.id]);
const tz = shop.iana_timezone || 'UTC';
const local = async (expr) => (await one(`select (${expr})::timestamp t`)).t;

// Date-range variants, as wall-clock timestamps in the shop's zone (what the app passes).
const RANGES = {
  last30: [await local(`(now() at time zone '${tz}') - interval '30 days'`), await local(`now() at time zone '${tz}'`)],
  halfYear: [await local(`date_trunc('month', now() at time zone '${tz}') - interval '6 months'`), await local(`date_trunc('month', now() at time zone '${tz}')`)],
  all: [await local(`'${new Date(span.lo).toISOString()}'::timestamptz at time zone '${tz}'`), await local(`now() at time zone '${tz}'`)]
};

/** One argument, from its name. `v` is the variant: { range, grain, channels, vip }. */
function argFor(name, type, v) {
  switch (name) {
    case 'p_shop': case 'match_shop_id': case 'p_shop_id': return shop.id;
    case 'p_from': return v.range[0];
    case 'p_to': return v.range[1];
    case 'p_tz': return tz;
    case 'p_grain': return v.grain;
    case 'p_channels': return v.channels === 'marketplaces' ? marketplaces : null;
    case 'p_not_channels': return v.channels === 'own' ? marketplaces : null;
    case 'p_vip_not_channels': case 'p_people_not_channels': return marketplaces;
    case 'p_vip_only': return v.vip;
    case 'p_min_spend': return shop.vip_min_spend ?? 100;
    case 'p_min_orders': return shop.vip_min_orders ?? 2;
    case 'p_window_months': return shop.vip_window_months ?? 12;
    case 'p_limit': return 25;
    case 'p_product_id': return product;
    case 'p_country': return v.country ? country : null;
    case 'p_checkout_minutes': return 30;
    case 'p_max_cover_days': return 30;
    case 'p_max_stock_units': return 5;
    case 'p_closed_statuses': return ['closed', 'resolved'];
    case 'p_min_level': return 1;
    case 'p_unhappy_from': return 3;
    case 'p_metric': return 'revenue';
    default: return type.endsWith('[]') ? null : null;
  }
}

const fns = (await client.query(`
  select p.oid, p.proname,
    coalesce(p.proargnames, '{}') names,
    array(select format_type(t, null) from unnest(p.proargtypes::oid[]) t) types,
    p.pronargs n
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' order by p.proname, p.oid`)).rows
  .filter((f) => FUNCTIONS.test(f.proname));

function variantsFor(names) {
  const has = (n) => names.includes(n);
  const ranges = has('p_from') ? Object.entries(RANGES) : [['-', null]];
  const out = [];
  for (const [rk, range] of ranges) {
    const grains = has('p_grain') ? ['day', 'week', 'month'] : [null];
    for (const grain of grains) {
      const channelSets = has('p_channels') || has('p_not_channels') ? ['all', 'own', 'marketplaces'] : ['all'];
      for (const channels of channelSets) {
        for (const vip of has('p_vip_only') ? [false, true] : [null]) {
          for (const c of has('p_country') ? [false, true] : [false]) {
            out.push({ key: [rk, grain, channels, vip, c ? 'country' : null].filter((x) => x !== null && x !== '-' && x !== 'all').join('/') || 'default', range, grain, channels, vip, country: c });
          }
        }
      }
    }
  }
  return out;
}

const result = {};
for (const f of fns) {
  const names = f.names.slice(0, f.n);
  const sig = `${f.proname}(${f.types.join(', ')})`;
  for (const v of variantsFor(names)) {
    const params = names.map((name, i) => argFor(name, f.types[i], v));
    const call = names.map((name, i) => `${name} => $${i + 1}::${f.types[i]}`).join(', ');
    let entry;
    try {
      await client.query('savepoint s');
      const rows = (await client.query(`select * from public.${f.proname}(${call})`, params)).rows;
      const lines = rows.map((r) => JSON.stringify(r)).sort();
      entry = { rows: rows.length, sha: createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16) };
      await client.query('release savepoint s');
    } catch (error) {
      await client.query('rollback to savepoint s');
      entry = { error: String(error.message).slice(0, 160) };
    }
    result[`${sig} ${v.key}`] = entry;
  }
}
await client.query('rollback');
await client.end();

writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), result }, null, 1));
const keys = Object.keys(result);
const errors = keys.filter((k) => result[k].error);
console.log(`fingerprinted ${fns.length} functions, ${keys.length} calls, ${errors.length} errors -> ${outFile}`);
for (const k of errors) console.log(`  error: ${k}: ${result[k].error}`);

if (beforeFile) {
  const before = JSON.parse(readFileSync(beforeFile, 'utf8')).result;
  const all = new Set([...Object.keys(before), ...keys]);
  const diffs = [...all].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(result[k]));
  console.log(diffs.length ? `${diffs.length} DIFFER from ${beforeFile}:` : `identical to ${beforeFile} (${all.size} calls)`);
  for (const k of diffs) console.log(`  ${k}\n    before ${JSON.stringify(before[k])}\n    after  ${JSON.stringify(result[k])}`);
  if (diffs.length) process.exitCode = 1;
}

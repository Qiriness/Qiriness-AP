import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

import { loadConfig, loadEnv } from '../lib/sync-config.mjs';
import { MIN_MEASURED_GAPS } from '../lib/advisory/replenishment.mjs';

// How long this shop's customers take to buy the same product again, per
// product and size: the storefront advisor's measured replenishment interval
// (scripts/lib/advisory/replenishment.mjs), shown read-only in the knowledge
// spreadsheet. READ-ONLY, aggregates only: no customer, order or person-level
// row leaves the database.
//
//   npm run advisor:repurchase                        this shop → data/advisor/repurchase/<shop>.json
//   npm run advisor:repurchase -- --shop x.myshopify.com --out file.json
//
// Over a direct connection (SUPABASE_DB_URL): one aggregate query, a few kB back.
//
// - Online store only: marketplace customers are synthetic, one per order.
// - Not cancelled or deleted; a line counts only if paid (> 0) and kept.
// - Same customer, same variant, consecutive purchases. Gaps under 7 days are
//   a split or corrected order, not a repurchase.
// - repeat_rate counts buyers whose first purchase is at least 180 days before
//   the latest order, so new buyers who had no time to repeat do not pull it down.
//   null: no buyer that old yet (a product or size launched in the last six months).
// - Written only with MIN_MEASURED_GAPS repurchases or more.

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const env = loadEnv();
const shopDomain = flag('--shop') ?? loadConfig(env).shopDomain;
const out = path.resolve(flag('--out') ?? `data/advisor/repurchase/${shopDomain}.json`);
if (!env.SUPABASE_DB_URL) throw new Error('SUPABASE_DB_URL is not set: this reads over a direct connection.');

const client = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query('begin read only');
  const { rows: [shop] } = await client.query('select id from shops where shop_domain = $1', [shopDomain]);
  if (!shop) throw new Error(`${shopDomain} is not a synced shop`);
  const { rows: [span] } = await client.query("select to_char(min(processed_at)::date, 'YYYY-MM-DD') first_day, to_char(max(processed_at)::date, 'YYYY-MM-DD') last_day from orders where shop_id = $1", [shop.id]);
  const { rows } = await client.query(`
    with market as (select unnest(handles) h from sales_channels where shop_id = $1),
    bought as (
      select o.shopify_customer_id c, l.product_id, coalesce(nullif(l.variant_title, ''), '—') size,
             o.processed_at::date d, sum(l.current_quantity::numeric) qty
      from orders o join order_lines l on l.order_id = o.id
      where o.shop_id = $1 and o.shopify_customer_id is not null
        and o.cancelled_at is null and o.deleted_at is null
        and coalesce(o.sales_channel_handle, '') not in (select h from market)
        and l.product_id is not null
        and l.discounted_total::numeric > 0 and l.current_quantity::numeric > 0
      group by 1, 2, 3, 4
    ),
    seq as (
      select *, d - lag(d) over w gap, lag(qty) over w prev_qty, min(d) over (partition by c, product_id, size) first_d
      from bought window w as (partition by c, product_id, size order by d)
    ),
    gaps as (select * from seq where gap >= 7)
    select p.handle, b.size,
           count(distinct b.c) buyers,
           count(distinct b.c) filter (where b.first_d <= $2::date - 180) buyers_old,
           count(distinct g.c) filter (where g.first_d <= $2::date - 180) repeaters_old,
           count(g.gap) gaps,
           percentile_cont(0.5) within group (order by g.gap) median_days,
           percentile_cont(0.25) within group (order by g.gap) p25_days,
           percentile_cont(0.75) within group (order by g.gap) p75_days,
           percentile_cont(0.5) within group (order by g.gap / greatest(g.prev_qty, 1)) median_days_per_unit
    from seq b
    join products p on p.shop_id = $1 and p.shopify_product_id = b.product_id
    left join gaps g on g.c = b.c and g.product_id = b.product_id and g.size = b.size and g.d = b.d
    group by p.handle, b.size
    having count(g.gap) >= $3
    order by count(g.gap) desc`, [shop.id, span.last_day, MIN_MEASURED_GAPS]);
  await client.query('rollback');

  const weeks = (days) => Math.round((Number(days) / 7) * 10) / 10;
  const file = {
    _about: 'Measured by scripts/advisor/measure-repurchase.mjs: median weeks before a customer rebought the same product and size. Aggregates only.',
    shop: shopDomain,
    window: [span.first_day, span.last_day],
    measured_on: new Date().toISOString().slice(0, 10),
    products: rows.map((r) => ({
      handle: r.handle,
      size: r.size,
      buyers: Number(r.buyers),
      repeat_rate: Number(r.buyers_old) ? Math.round((100 * Number(r.repeaters_old)) / Number(r.buyers_old)) : null,
      gaps: Number(r.gaps),
      median_weeks: weeks(r.median_days),
      p25_weeks: weeks(r.p25_days),
      p75_weeks: weeks(r.p75_days),
      median_weeks_per_unit: weeks(r.median_days_per_unit),
    })),
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
  console.log(`${shopDomain}: ${file.products.length} product sizes with ${MIN_MEASURED_GAPS}+ repurchases (${file.window.join(' → ')}) → ${path.relative(process.cwd(), out)}`);
} finally {
  await client.end();
}

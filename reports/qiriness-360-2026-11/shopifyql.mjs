// ShopifyQL reads for reconciliation and traffic sources, Qiriness only, read-only.
//   node reports/qiriness-360-2026-11/shopifyql.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, loadConfig } from '../../scripts/lib/sync-config.mjs';
import { createShopifyClient } from '../../scripts/lib/shopify-admin-client.mjs';
import { askShopifyql } from '../../scripts/lib/shopifyql-client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig(loadEnv(path.resolve(here, '..', '..')));
if (config.shopDomain !== 'qiriness.myshopify.com') throw new Error(`refused: shop domain is ${config.shopDomain}`);

const QUERIES = {
  sql_sales_month: "FROM sales SHOW orders, gross_sales, discounts, returns, net_sales, taxes, total_sales WHERE sales_channel = 'Online Store' GROUP BY month SINCE 2025-03-01 UNTIL 2026-10-31 ORDER BY month",
  sql_sessions_source: 'FROM sessions SHOW sessions, conversion_rate GROUP BY referrer_source SINCE 2025-11-01 UNTIL 2026-10-31 ORDER BY sessions DESC',
  sql_sessions_source_month: 'FROM sessions SHOW sessions, conversion_rate GROUP BY referrer_source, month SINCE 2025-03-01 UNTIL 2026-10-31 ORDER BY month',
};

function toCsv(rows) {
  if (!rows?.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (x) => (x === null || x === undefined ? '' : /[",\n]/.test(String(x)) ? `"${String(x).replace(/"/g, '""')}"` : String(x));
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(typeof r[c] === 'object' ? JSON.stringify(r[c]) : r[c])).join(','))].join('\n') + '\n';
}

const client = await createShopifyClient(config);
for (const [name, q] of Object.entries(QUERIES)) {
  try {
    const r = await askShopifyql(client, q);
    const rows = r.rows || r.table?.rows || r.tableData?.rows || r;
    fs.writeFileSync(path.join(here, 'data', `${name}.csv`), toCsv(Array.isArray(rows) ? rows : []));
    console.log(`ok   ${name}`, Array.isArray(rows) ? rows.length : JSON.stringify(r).slice(0, 300));
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message}`);
  }
}

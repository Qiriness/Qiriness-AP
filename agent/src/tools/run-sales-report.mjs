import { createSupabaseClient, supabaseSelect } from '../../../scripts/lib/supabase-rest-client.mjs';
import { lastCompleteMonth } from '../../../scripts/lib/insights-range.mjs';

import { loadAgentConfig, assertGraphConfig } from '../config.mjs';
import { resolveServedShops } from '../lib/shop.mjs';
import { createGraphClient } from '../ingestion/graph-client.mjs';
import { sendSalesReport } from '../reports/sales-report-mail.mjs';

// A TEST SEND of the monthly sales report, to SALES_REPORT_EXTRA_RECIPIENTS
// only — never the management accounts. No schedule and no integration_events
// row, so it cannot stand in for the real send on the 1st. Sent from the shop's
// own sender (`shops.report_sender`, Settings → Integrations), as the real one.
//
//   npm run report:sales:test                              # desk shop, last complete month
//   npm run report:sales:test -- --month=2026-08
//   npm run report:sales:test -- --shop=gurkk8-er          # another DASHBOARD_SHOPS shop

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  assertGraphConfig(config);
  const report = config.salesReport;
  if (!report.url || !report.secret) throw new Error('Set SALES_REPORT_URL and SALES_REPORT_SECRET first.');
  if (report.extraRecipients.length === 0) throw new Error('Set SALES_REPORT_EXTRA_RECIPIENTS: the test goes only there.');

  const flag = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const wanted = flag('shop');
  const listed = config.dashboardShops.find((shop) => (wanted ? shop.slug === wanted : shop.desk));
  if (!listed) throw new Error(`No shop "${wanted}" in DASHBOARD_SHOPS.`);

  const supabase = createSupabaseClient(config);
  const [shopRow] = await resolveServedShops(supabase, [listed]);
  if (!shopRow) throw new Error(`No shops row for ${listed.domain}. Run its nightly sync first.`);
  const [shop] = await supabaseSelect(supabase, 'shops', { id: shopRow.id }, 'shop_name,iana_timezone,report_sender');
  const sender = shop?.report_sender;
  if (!sender) throw new Error(`No sender for ${listed.slug}: set it on Settings → Integrations for that shop.`);
  const month = flag('month') ?? lastCompleteMonth({ tz: shop?.iana_timezone || 'UTC' });

  const { html, subject } = await sendSalesReport({
    graphClient: createGraphClient(config),
    config: report,
    month,
    brand: shop?.shop_name || 'Shop',
    recipients: report.extraRecipients,
    shopSlug: shopRow.slug,
    sender
  });
  console.log(`Sent « ${subject} » (${Buffer.byteLength(html)} bytes) from ${sender} to ${report.extraRecipients.join(', ')}.`);
}

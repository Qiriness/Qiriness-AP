import { createSupabaseClient, supabaseSelect } from '../../../scripts/lib/supabase-rest-client.mjs';
import { lastCompleteMonth } from '../../../scripts/lib/insights-range.mjs';

import { loadAgentConfig, assertGraphConfig } from '../config.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { createGraphClient } from '../ingestion/graph-client.mjs';
import { sendSalesReport } from '../reports/sales-report-mail.mjs';

// A TEST SEND of the monthly sales report, to SALES_REPORT_EXTRA_RECIPIENTS
// only — never the management accounts. No schedule and no integration_events
// row, so it cannot stand in for the real send on the 1st.
//
//   npm run report:sales:test                  # last complete month
//   npm run report:sales:test -- --month=2026-08

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

  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);
  const [shop] = await supabaseSelect(supabase, 'shops', { id: shopId }, 'shop_name,iana_timezone');
  const flag = process.argv.find((arg) => arg.startsWith('--month='));
  const month = flag ? flag.slice('--month='.length) : lastCompleteMonth({ tz: shop?.iana_timezone || 'UTC' });

  const { html, subject } = await sendSalesReport({
    graphClient: createGraphClient(config),
    config: report,
    month,
    brand: shop?.shop_name || 'Shop',
    recipients: report.extraRecipients
  });
  console.log(`Sent « ${subject} » (${Buffer.byteLength(html)} bytes) from ${config.graph.mailbox} to ${report.extraRecipients.join(', ')}.`);
}

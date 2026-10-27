import { createSupabaseClient, supabaseSelect } from '../../../scripts/lib/supabase-rest-client.mjs';
import { resolveRecipients } from '../../../scripts/lib/shop-mail-settings.mjs';
import { readAlertProducts, stockAlertFileName, stockAlertMail, stockAlertWorkbook } from '../../../scripts/lib/stock-alert.mjs';
import { createAdminClient } from '../../../scripts/lib/dashboard-user-admin.mjs';

import { loadAgentConfig, assertGraphConfig } from '../config.mjs';
import { resolveServedShops } from '../lib/shop.mjs';
import { createGraphClient } from '../ingestion/graph-client.mjs';

// A TEST SEND of the stock alert, as the real one would go: from the shop's
// stock_alert_sender to its stock_alert_recipients (Settings → Integrations),
// plus any --also addresses. Every product out of stock or critical now is
// treated as new, so the mail shows the full list. Subject marked [TEST]. No
// stock_alerts row is written: the real alert's state is untouched.
//
//   npm run alert:stock:test -- --shop=qiriness --also=me@example.com

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  assertGraphConfig(config);
  const flag = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const wanted = flag('shop');
  const listed = config.dashboardShops.find((shop) => (wanted ? shop.slug === wanted : shop.desk));
  if (!listed) throw new Error(`No shop "${wanted}" in DASHBOARD_SHOPS.`);

  const supabase = createSupabaseClient(config);
  const [served] = await resolveServedShops(supabase, [listed]);
  if (!served) throw new Error(`No shops row for ${listed.domain}.`);
  const [shop] = await supabaseSelect(supabase, 'shops', { id: served.id }, 'shop_name,iana_timezone,stock_alert_sender,stock_alert_recipients');
  if (!shop?.stock_alert_sender) throw new Error(`No stock alert sender for ${listed.slug}: set it on Settings → Integrations.`);

  const admin = createAdminClient({ url: config.supabaseUrl, secretKey: config.supabaseKey });
  const also = (flag('also') ?? '').split(',').map((a) => a.trim().toLowerCase()).filter(Boolean);
  const recipients = [...new Set([...resolveRecipients(shop.stock_alert_recipients ?? [], await admin.listUsers()), ...also])];
  if (recipients.length === 0) throw new Error('Nobody to send to: no saved recipient and no --also.');

  const brand = shop.shop_name || 'Shop';
  const items = await readAlertProducts(supabase, { shopId: served.id, tz: shop.iana_timezone || 'UTC' });
  const newIds = items.map((item) => item.productId);
  const mail = stockAlertMail({ brand, items, newIds });
  const now = new Date();
  await createGraphClient(config).sendMail({
    subject: `[TEST] ${mail.subject}`,
    text: mail.text,
    toRecipients: recipients,
    from: shop.stock_alert_sender,
    attachments: [
      {
        name: stockAlertFileName(brand, now),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        content: stockAlertWorkbook(items, newIds)
      }
    ]
  });
  console.log(`Sent « [TEST] ${mail.subject} » from ${shop.stock_alert_sender} to ${recipients.join(', ')}: ${items.length} products listed.`);
}

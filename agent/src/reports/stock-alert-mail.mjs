import { supabaseInsert, supabaseSelect } from '../../../scripts/lib/supabase-rest-client.mjs';
import { sanitizeError } from '../../../scripts/lib/compliance-audit.mjs';
import { resolveRecipients } from '../../../scripts/lib/shop-mail-settings.mjs';
import {
  alertState,
  newlyAlerting,
  readAlertProducts,
  sameState,
  stockAlertFileName,
  stockAlertMail,
  stockAlertWorkbook
} from '../../../scripts/lib/stock-alert.mjs';
import { T } from '../../../scripts/lib/tables.mjs';

/**
 * THE STOCK ALERT, ONCE A DAY PER SHOP (owner, 2026-10-27: "once a day is ok").
 *
 * Stock only moves when the nightly product sync runs, so the check runs once
 * per shop after each product sync: when the newest `products.synced_at` is
 * one this worker has not checked yet. A late nightly, or one run by hand, is
 * still followed by one check; a worker restart checks once more, which sends
 * nothing twice because the state is in `stock_alerts`, not in memory.
 *
 * WHAT IS SENT: when a product is newly out of stock or critical (stock-alert.mjs
 * `newlyAlerting`), the shop's `stock_alert_recipients` get the Excel file of
 * every product out of stock or critical, from `stock_alert_sender`. A shop
 * without both is skipped and nothing is recorded.
 *
 * WHAT IS RECORDED (`stock_alerts`): the first check is a silent `baseline`, so
 * switching the alert on does not mail every product already short. A check
 * whose set changed without anything new (a product restocked) writes a
 * `baseline`, so that product counts as new if it falls back. A failed send is
 * a `failed` row and leaves the state as it was: the next product sync's check
 * sends again.
 */

// Per shop: the newest products.synced_at already checked.
const checkedSync = new Map();

export async function runStockAlert({ supabase, graphClient, adminClient, shopId, logger, now = new Date(), force = false }) {
  const [latest] = await supabaseSelect(supabase, T.PRODUCTS, { shop_id: shopId }, 'synced_at', {
    order: 'synced_at.desc.nullslast',
    limit: 1
  });
  const syncedAt = latest?.synced_at ?? null;
  if (!force && (!syncedAt || checkedSync.get(shopId) === syncedAt)) return { skipped: 'no_new_sync' };
  checkedSync.set(shopId, syncedAt);

  const [shop] = await supabaseSelect(supabase, T.SHOPS, { id: shopId }, 'shop_name,iana_timezone,stock_alert_sender,stock_alert_recipients');
  if (!shop?.stock_alert_sender || !(shop.stock_alert_recipients ?? []).length) return { skipped: 'not_configured' };

  const items = await readAlertProducts(supabase, { shopId, tz: shop.iana_timezone || 'UTC', now });
  const current = alertState(items);
  const [last] = await supabaseSelect(
    supabase,
    T.STOCK_ALERTS,
    { shop_id: shopId, status: { operator: 'in', value: '(baseline,sent)' } },
    'out_product_ids,critical_product_ids',
    { order: 'created_at.desc', limit: 1 }
  );
  const record = (row) =>
    supabaseInsert(supabase, T.STOCK_ALERTS, [{ shop_id: shopId, out_product_ids: current.out, critical_product_ids: current.critical, ...row }], {
      returning: 'minimal'
    });

  if (!last) {
    await record({ status: 'baseline' });
    logger.info('stock_alert.baseline', { shopId, out: current.out.length, critical: current.critical.length });
    return { baseline: true };
  }
  const previous = { out: last.out_product_ids ?? [], critical: last.critical_product_ids ?? [] };
  const newIds = newlyAlerting(previous, current);
  if (newIds.length === 0) {
    if (!sameState(previous, current)) await record({ status: 'baseline' });
    return { skipped: 'nothing_new' };
  }

  const brand = shop.shop_name || 'Shop';
  try {
    const recipients = resolveRecipients(shop.stock_alert_recipients, await adminClient.listUsers());
    if (recipients.length === 0) throw new Error('No recipients: the roles chosen have no active account and no address is listed.');
    const mail = stockAlertMail({ brand, items, newIds });
    await graphClient.sendMail({
      ...mail,
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
    await record({ status: 'sent', new_product_ids: newIds, recipients: recipients.length });
    logger.info('stock_alert.sent', { shopId, new: newIds.length, listed: items.length, recipients: recipients.length });
    return { sent: true, new: newIds.length, listed: items.length };
  } catch (error) {
    await record({ status: 'failed', new_product_ids: newIds, error_summary: sanitizeError(error) }).catch(() => {});
    logger.error('stock_alert.failed', { shopId, error: sanitizeError(error) });
    return { sent: false, error: error.message };
  }
}

import { randomBytes } from 'node:crypto';

import { hashClientState } from '../../../scripts/lib/mail-subscription-record.mjs';
import { MAIL_FOLDERS } from './mail-provider.mjs';

/**
 * KEEPS THE OUTLOOK CHANGE-NOTIFICATION SUBSCRIPTIONS ALIVE. One per folder
 * (Inbox, Sent Items), created when missing, renewed before they lapse,
 * recreated when Graph no longer has them.
 *
 * DORMANT WITHOUT `MAIL_WEBHOOK_URL`. Graph only delivers to a public HTTPS
 * endpoint that answers its validation handshake, and nothing in this project
 * is deployed yet. Unset, this returns at once and the poll carries on alone.
 *
 * A SUBSCRIPTION IS A TRIGGER, NEVER THE TRUTH. A notification only enqueues a
 * `sync_mailbox` job; the delta read decides what is new. Losing one costs
 * latency until the next timed poll, never mail. So a failure here is logged
 * at error level and written on the row (the alert, until there is an alert
 * channel) and the poll continues.
 *
 * Outlook-specific by nature (Gmail's equivalent is a Pub/Sub watch), so it
 * talks to the Graph client directly rather than through the MailProvider.
 */

// Graph caps mail subscriptions at a few days. 4,200 minutes stays under the
// oldest documented cap (4,230) as well as the current one.
export const SUBSCRIPTION_LIFETIME_MS = 4200 * 60 * 1000;
export const RENEW_WITHIN_MS = 24 * 60 * 60 * 1000;

/** What to do for one folder. Pure. */
export function subscriptionPlan(row, now = new Date(), { renewWithinMs = RENEW_WITHIN_MS } = {}) {
  if (!row) return 'create';
  if (row.needs_renewal) return 'renew';
  const expiresAt = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt - now.getTime() < renewWithinMs) return 'renew';
  return 'keep';
}

export async function manageSubscriptions({
  graphClient,
  subscriptions,
  shopId,
  webhookUrl,
  lifecycleUrl = null,
  now = new Date(),
  logger,
  newSecret = () => randomBytes(32).toString('base64url')
}) {
  const totals = { created: 0, renewed: 0, kept: 0, failed: 0 };
  if (!webhookUrl) return totals;

  const rows = await subscriptions.forShop(shopId, 'outlook');
  const expiry = () => new Date(now.getTime() + SUBSCRIPTION_LIFETIME_MS).toISOString();

  for (const folder of MAIL_FOLDERS) {
    const row = rows.find((r) => r.folder === folder) ?? null;
    const plan = subscriptionPlan(row, now);
    if (plan === 'keep') {
      totals.kept += 1;
      continue;
    }
    try {
      if (plan === 'renew') {
        const renewed = await graphClient.renewSubscription(row.subscription_id, expiry());
        if (!renewed.gone) {
          await subscriptions.saveRenewed(row.id, { expiresAt: renewed.expirationDateTime, at: now });
          totals.renewed += 1;
          continue;
        }
        logger?.warn?.('mail.subscription_gone', { shopId, folder });
      }
      const secret = newSecret();
      const created = await graphClient.createSubscription({
        folder,
        notificationUrl: webhookUrl,
        lifecycleNotificationUrl: lifecycleUrl || webhookUrl,
        clientState: secret,
        expirationDateTime: expiry()
      });
      await subscriptions.saveCreated({
        shopId,
        folder,
        subscriptionId: created.id,
        clientStateHash: hashClientState(secret),
        expiresAt: created.expirationDateTime,
        at: now
      });
      totals.created += 1;
      logger?.info?.('mail.subscription_created', { shopId, folder });
    } catch (error) {
      totals.failed += 1;
      logger?.error?.('mail.subscription_renew_failed', { shopId, folder, plan, error: error.message });
      if (row) await subscriptions.saveError(row.id, error).catch(() => {});
    }
  }
  return totals;
}

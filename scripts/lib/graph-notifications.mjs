import { clientStateMatches } from './mail-subscription-record.mjs';
import { syncDedupeKey } from './mail-job-record.mjs';

/**
 * WHAT THE GRAPH WEBHOOK DOES, as a function the route calls and the tests
 * drive. `web/app/api/webhooks/graph/route.ts` is only the HTTP glue.
 *
 * IT READS NO MAIL. A notification says "something changed in this folder";
 * the answer is one `sync_mailbox` job for that folder, and the worker's delta
 * read decides what, if anything, is new. So a forged, replayed or duplicated
 * notification can at worst make the worker read a folder early.
 *
 * A NOTIFICATION IS BELIEVED ONLY WITH ITS SECRET: its subscription must be one
 * we created and its clientState must hash to what we stored. Anything else is
 * dropped quietly with a 202, because an error status makes Graph retry.
 *
 * `validationToken` is Graph's handshake when a subscription is created: echo
 * it back as plain text within ten seconds, or the subscription is refused.
 */

const LIFECYCLE_RENEW = new Set(['reauthorizationRequired', 'subscriptionRemoved']);
const MAX_TOKEN_LENGTH = 4096;

/**
 * @param {object} input
 * @param {string|null} input.validationToken  the query parameter, if present
 * @param {string} input.rawBody
 * @param {object} input.subscriptions         mail-subscription-record
 * @param {(shopId: string) => { enqueue: Function }} input.jobsFor  a mail-job-record per shop
 * @param {{ warn?: Function }} [input.logger]
 * @returns {Promise<{ status: number, contentType: string, body: string, summary: object }>}
 */
export async function handleGraphNotification({ validationToken = null, rawBody = '', subscriptions, jobsFor, logger }) {
  if (validationToken !== null && validationToken !== undefined) {
    const token = String(validationToken).slice(0, MAX_TOKEN_LENGTH);
    return { status: 200, contentType: 'text/plain', body: token, summary: { validation: true } };
  }

  const summary = { received: 0, accepted: 0, rejected: 0, lifecycle: 0, enqueued: 0 };
  let payload;
  try {
    payload = JSON.parse(rawBody || '{}');
  } catch {
    return accepted(summary);
  }
  const notifications = Array.isArray(payload?.value) ? payload.value : [];
  const toSync = new Map();

  for (const notification of notifications) {
    summary.received += 1;
    const subscription = await subscriptions.bySubscriptionId(notification?.subscriptionId);
    if (!subscription || !clientStateMatches(notification?.clientState, subscription.client_state_hash)) {
      summary.rejected += 1;
      continue;
    }
    summary.accepted += 1;
    if (notification.lifecycleEvent) {
      summary.lifecycle += 1;
      if (LIFECYCLE_RENEW.has(notification.lifecycleEvent)) {
        await subscriptions.flagRenewal(subscription.subscription_id);
      }
      logger?.warn?.('mail.subscription_lifecycle', { folder: subscription.folder, event: notification.lifecycleEvent });
    }
    // Every accepted notification, lifecycle included, asks for a read: a
    // `missed` event means exactly that changes went unannounced.
    toSync.set(`${subscription.shop_id}|${subscription.folder}`, subscription);
  }

  for (const subscription of toSync.values()) {
    await jobsFor(subscription.shop_id).enqueue({
      kind: 'sync_mailbox',
      dedupeKey: syncDedupeKey(subscription.folder),
      payload: { folder: subscription.folder }
    });
    summary.enqueued += 1;
  }
  if (summary.rejected > 0) logger?.warn?.('mail.notification_rejected', { rejected: summary.rejected });
  return accepted(summary);
}

function accepted(summary) {
  return { status: 202, contentType: 'text/plain', body: '', summary };
}

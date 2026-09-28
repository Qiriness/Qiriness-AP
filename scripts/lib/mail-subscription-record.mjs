import { createHash, timingSafeEqual } from 'node:crypto';

import { supabaseSelect, supabaseUpdate, supabaseUpsert } from './supabase-rest-client.mjs';
import { T } from './tables.mjs';

/**
 * The `mail_subscriptions` rows, and the only module that writes them. The
 * worker creates and renews (agent/src/mail/subscription-manager.mjs); the
 * webhook reads one to believe a notification and flags it for renewal when
 * the provider says so. Both runtimes, hence scripts/lib.
 *
 * THE CLIENT STATE IS NEVER STORED. It is the secret a notification must echo;
 * the row keeps its sha256 and a notification is believed when the hash of
 * what it carries matches, compared in constant time.
 */

export function hashClientState(secret) {
  return createHash('sha256').update(String(secret ?? ''), 'utf8').digest('hex');
}

/** Whether `received` is the secret whose hash is `storedHash`. Constant time. */
export function clientStateMatches(received, storedHash) {
  if (typeof received !== 'string' || received === '' || typeof storedHash !== 'string') return false;
  const a = Buffer.from(hashClientState(received), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

const COLUMNS =
  'id,shop_id,provider,folder,subscription_id,client_state_hash,expires_at,last_renewed_at,needs_renewal,last_error,last_error_at';

export const REST_TRANSPORT = { select: supabaseSelect, update: supabaseUpdate, upsert: supabaseUpsert };

/**
 * Not shop-scoped at construction, unlike the other records: the webhook
 * learns the shop FROM the subscription it looks up.
 */
export function createMailSubscriptionRecord(supabase, { transport = REST_TRANSPORT } = {}) {
  const { select, update, upsert } = transport;

  return {
    async forShop(shopId, provider = 'outlook') {
      return select(supabase, T.MAIL_SUBSCRIPTIONS, { shop_id: shopId, provider }, COLUMNS);
    },

    async bySubscriptionId(subscriptionId) {
      if (!subscriptionId) return null;
      const rows = await select(supabase, T.MAIL_SUBSCRIPTIONS, { subscription_id: subscriptionId }, COLUMNS, { limit: 1 });
      return rows[0] ?? null;
    },

    /** A subscription created (or recreated): one row per shop, provider and folder. */
    async saveCreated({ shopId, provider = 'outlook', folder, subscriptionId, clientStateHash, expiresAt, at = new Date() }) {
      const rows = await upsert(
        supabase,
        T.MAIL_SUBSCRIPTIONS,
        [
          {
            shop_id: shopId,
            provider,
            folder,
            subscription_id: subscriptionId,
            client_state_hash: clientStateHash,
            expires_at: expiresAt,
            last_renewed_at: at.toISOString(),
            needs_renewal: false,
            last_error: null,
            last_error_at: null
          }
        ],
        'shop_id,provider,folder'
      );
      return rows?.[0] ?? null;
    },

    async saveRenewed(id, { expiresAt, at = new Date() }) {
      return update(
        supabase,
        T.MAIL_SUBSCRIPTIONS,
        { id },
        { expires_at: expiresAt, last_renewed_at: at.toISOString(), needs_renewal: false, last_error: null, last_error_at: null },
        { select: 'id' }
      );
    },

    async saveError(id, error, at = new Date()) {
      const text = String(error?.message ?? error ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
      return update(supabase, T.MAIL_SUBSCRIPTIONS, { id }, { last_error: text, last_error_at: at.toISOString() }, { select: 'id' });
    },

    /** The provider asked for reauthorisation, or removed it: renew at the next poll. */
    async flagRenewal(subscriptionId) {
      return update(supabase, T.MAIL_SUBSCRIPTIONS, { subscription_id: subscriptionId }, { needs_renewal: true }, { select: 'id' });
    }
  };
}

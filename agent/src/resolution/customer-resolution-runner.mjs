import { hashIdentifier } from '../../../scripts/lib/compliance-audit.mjs';
import {
  supabaseSelectAll,
  supabaseUpdateById
} from '../../../scripts/lib/supabase-rest-client.mjs';

// Fills `tickets.customer_id` from the address the ticket was opened with.
//
// WHY IT RUNS ON ITS OWN. The CRM lookup (retrieval/customer-lookup.mjs) already
// answers "who wrote in" from the requester hash alone, but until now nothing
// called it: the only writer of `customer_id` was the order-context pass, which
// reaches a customer through a CONFIRMED order number. That leaves every ticket
// without an order number — account questions, pre-sales, anything from the
// contact form — permanently unlinked, even when the sender is a known customer
// with forty orders behind them. This pass closes that gap: identity is
// something the ticket has from its first message, so it is resolved then rather
// than as a by-product of resolving an order.
//
// THE IDENTITY IS THE TICKET'S RECORDED REQUESTER, not the envelope sender. For
// Shopify contact-form mail those differ: the envelope is mailer@shopify.com and
// the real address is the one the customer typed into the form, which
// ingestion/contact-form.mjs already promoted onto `requester_email_hash` (see
// graph-message-mapper.mjs). Keying on that column is what makes form mail
// resolve to the person rather than to Shopify — and NOTIFICATION_SENDERS below
// is the guard for the case where that promotion did not happen.
//
// Selects on ticket state, not on what the current poll wrote, so a ticket
// missed by a crashed pass — or one whose customer only reached us in last
// night's sync — is caught up automatically.

/**
 * Addresses that are never a customer, matched by hash.
 *
 * A contact-form notification whose body does not parse degrades to the
 * envelope, so its requester becomes Shopify's own mailer. On a real inbox that
 * was 95 tickets sharing 2 hashes; if such an address ever appeared in
 * `customers` — a staff account, a test order — every one of those tickets would
 * link to the same wrong person, and a drafting step would then address a
 * stranger by name. Cheaper to refuse the handful of addresses that cannot
 * belong to a buyer than to detect the damage afterwards.
 *
 * The support mailbox is added by the caller (it comes from config, not source).
 */
export const NOTIFICATION_SENDERS = [
  'mailer@shopify.com',
  'noreply@shopify.com',
  'no-reply@shopify.com'
];

/**
 * How long a `no_match` stands before it is asked again.
 *
 * A miss is a real answer — most senders never created an account — but not a
 * permanent one: customers arrive from the nightly Shopify sync, so today's
 * unknown address is next week's customer. The poll runs every minute and the
 * answer can only change once a night, so retrying every poll would write a
 * metadata row per unmatched ticket per minute to learn nothing. A day is the
 * cadence at which the underlying data actually moves.
 */
export const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

const LINKED = 'linked';
const NO_MATCH = 'no_match';
const NOT_A_CUSTOMER_ADDRESS = 'not_a_customer_address';

export function createCustomerResolutionStore(supabase) {
  return {
    /**
     * Tickets that know an address but not which customer it is.
     *
     * `requester_email_hash` is only ever written from an inbound message, so a
     * non-null hash also means the thread holds customer mail — a ticket opened
     * by one of our own replies carries no requester and is correctly skipped
     * until the customer's own message backfills it (ticket-writer.mjs).
     */
    async findUnlinked(shopId, { limit = 500 } = {}) {
      return supabaseSelectAll(
        supabase,
        'tickets',
        {
          shop_id: shopId,
          customer_id: { operator: 'is', value: 'null' },
          requester_email_hash: { operator: 'not.is', value: 'null' },
          deleted_at: { operator: 'is', value: 'null' }
        },
        'id,customer_id,requester_email_hash,metadata',
        { limit }
      );
    },

    /**
     * Writes the link, and always the reasoning.
     *
     * `customer_id` moves only on a match; `metadata.customer_resolution` is
     * written either way, so an unlinked ticket is explained rather than merely
     * empty and the next pass can see what was already tried against which
     * address.
     */
    async recordResolution(ticket, resolution) {
      const patch = {
        metadata: {
          ...(ticket.metadata || {}),
          customer_resolution: {
            status: resolution.status,
            matched_by: resolution.matchedBy,
            // The hash the attempt was made against. A ticket's requester can be
            // backfilled after the fact, and an attempt against the old identity
            // says nothing about the new one.
            email_hash: resolution.emailHash,
            attempted_at: resolution.attemptedAt
          }
        }
      };
      if (resolution.customerId) {
        patch.customer_id = resolution.customerId;
      }
      await supabaseUpdateById(supabase, 'tickets', ticket.id, patch);
    }
  };
}

export async function runCustomerResolution({
  store,
  lookup,
  shopId,
  logger,
  excludedEmails = [],
  now = new Date(),
  dryRun = false,
  onResult
} = {}) {
  const tickets = await store.findUnlinked(shopId);
  const totals = {
    considered: tickets.length,
    [LINKED]: 0,
    [NO_MATCH]: 0,
    [NOT_A_CUSTOMER_ADDRESS]: 0,
    deferred: 0
  };

  const skipHashes = new Set(
    [...NOTIFICATION_SENDERS, ...excludedEmails].map(hashIdentifier).filter(Boolean)
  );
  const pending = tickets.filter((ticket) => shouldAttempt(ticket, now));
  totals.deferred = tickets.length - pending.length;

  if (pending.length === 0) {
    logger?.info?.('customer.resolution', { shopId, ...totals });
    return totals;
  }

  // The lookup caches its hash index for the life of the process, so a customer
  // created since the worker started would otherwise be invisible for ever.
  // Dropped once per pass rather than per ticket, and only when there is
  // something to look up — the rebuild is a scan.
  lookup.refresh?.();

  for (const ticket of pending) {
    const attemptedAt = now.toISOString();
    const emailHash = ticket.requester_email_hash;
    let resolution;

    if (skipHashes.has(emailHash)) {
      // Recorded once and never retried: this is a property of the address, not
      // of what the customers table happens to hold today.
      resolution = { status: NOT_A_CUSTOMER_ADDRESS, matchedBy: null, customerId: null, emailHash, attemptedAt };
    } else {
      const result = await lookup.lookupCustomer({ ticket });
      resolution = {
        status: result.found ? LINKED : NO_MATCH,
        matchedBy: result.matchedBy ?? null,
        customerId: result.customerId ?? null,
        emailHash,
        attemptedAt
      };
    }

    totals[resolution.status] += 1;
    onResult?.({ ticket, resolution });

    if (!dryRun) {
      await store.recordResolution(ticket, resolution);
    }
  }

  logger?.info?.('customer.resolution', { shopId, ...totals });
  return totals;
}

/**
 * Whether this ticket is worth asking about now.
 *
 * Applied in JS rather than as a filter, because the marker is a jsonb object
 * and the decision reads three things from it — the same reason auto-close
 * applies its level exemption here rather than in PostgREST.
 */
function shouldAttempt(ticket, now) {
  const previous = ticket.metadata?.customer_resolution;
  if (!previous) {
    return true;
  }
  // The requester changed under us (a backfill, or a re-parsed contact form):
  // whatever was decided about the old address does not apply to this one.
  if (previous.email_hash !== ticket.requester_email_hash) {
    return true;
  }
  if (previous.status === NOT_A_CUSTOMER_ADDRESS) {
    return false;
  }
  const attemptedAt = Date.parse(previous.attempted_at || '');
  if (!Number.isFinite(attemptedAt)) {
    return true;
  }
  return now.getTime() - attemptedAt >= RETRY_AFTER_MS;
}

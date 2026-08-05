import { hashIdentifier, recordDataAccessEvent } from '../../../scripts/lib/compliance-audit.mjs';
import { supabaseSelectAll } from '../../../scripts/lib/supabase-rest-client.mjs';

import { buildAccountState, buildCustomerContext, toPromptText } from './customer-context.mjs';

// The customer/CRM tool: who wrote in, what they have bought, and whether their
// account works — WITHOUT needing an order number first.
//
// WHY IT IS SEPARATE FROM THE ORDER CONTEXT. The order-context bundle already
// carries a customer, but only ever reaches one by resolving an order, and only
// once that order is CONFIRMED. That leaves a whole class of ticket unanswerable:
// the `account` questions ("mon compte ne fonctionne pas", "combien de commandes
// ai-je passées ?") have no order number to resolve, and never will. This tool
// enters from the identity the ticket always has — the sender — so those tickets
// get an answer without the order pipeline being involved at all.
//
// TWO WAYS IN, because the caller holds one of two things:
//   findByEmail(address)  — a raw address, e.g. typed by a human running the CLI
//   findByEmailHash(hash) — `tickets.requester_email_hash`, which is all a ticket
//                           stores, and the path the worker will actually take
//
// Both land on the same bundle. The hash path exists so the ticket side never has
// to hold a raw address to ask a question about it.

const COLUMNS = [
  'id', 'shopify_customer_id', 'display_name', 'first_name', 'last_name',
  'email', 'locale', 'state', 'verified_email', 'valid_email_address',
  'tags', 'email_marketing_state', 'email_marketing_consent_updated_at',
  'on_email_marketing_list',
  'default_address_city', 'default_address_country',
  'number_of_orders', 'amount_spent', 'amount_spent_currency',
  'last_order_name', 'last_order_at', 'last_order_total', 'rfm_group'
].join(',');

export function createCustomerLookup({ supabase, shopId, logger, audit = true }) {
  let hashIndexPromise = null;

  /**
   * Maps sha256(email) -> customer id for the whole shop.
   *
   * WHY A SCAN AND A CACHE. `tickets.requester_email_hash` is a hash and
   * `customers.email` is plaintext, so there is no column to join them on — the
   * hash has to be computed on this side. Only `id,email` is read, never the
   * rest of the row, and the shop's catalogue of customers is walked once per
   * process rather than once per ticket.
   *
   * This is correct at any size and cheap at ours. The scaling fix, when it is
   * needed, is a stored generated `customers.email_hash` column with an index,
   * which turns this into a single indexed query — deliberately not done yet,
   * because it is a migration and this works without one.
   */
  function loadHashIndex() {
    if (!hashIndexPromise) {
      hashIndexPromise = supabaseSelectAll(
        supabase,
        'customers',
        { shop_id: shopId, deleted_at: { operator: 'is', value: 'null' } },
        'id,email'
      ).then((rows) => {
        const index = new Map();
        for (const row of rows) {
          const hash = hashIdentifier(row.email);
          // First writer wins. Two customer records on one address is a Shopify
          // data problem, not something to resolve by picking the later row.
          if (hash && !index.has(hash)) {
            index.set(hash, row.id);
          }
        }
        return index;
      });
    }
    return hashIndexPromise;
  }

  async function fetchById(customerId) {
    const rows = await supabaseSelectAll(supabase, 'customers', { id: customerId }, COLUMNS);
    return rows[0] || null;
  }

  /**
   * Records the read against `data_access_events`.
   *
   * FAILS OPEN, ON PURPOSE. By the time this runs the personal data has already
   * been read; throwing here would not un-read it, it would only also lose the
   * answer the customer is waiting for. So an audit failure is logged loudly and
   * the lookup still returns. The identifier is hashed, per the column's own
   * contract — the audit trail must not itself become a store of customer ids.
   */
  async function recordAccess(customer, matchedBy) {
    if (!audit) {
      return;
    }
    try {
      await recordDataAccessEvent(supabase, {
        shop_id: shopId,
        actor_type: 'service',
        actor_id: 'support-agent',
        action: 'customer_lookup',
        resource_type: 'customers',
        resource_id_hash: hashIdentifier(customer.shopify_customer_id),
        purpose: 'answering a support ticket',
        metadata: { matched_by: matchedBy }
      });
    } catch (error) {
      logger?.error?.('customer.audit_failed', { message: error.message });
    }
  }

  return {
    /** Drops the cached hash index — call after a customer sync. */
    refresh() {
      hashIndexPromise = null;
    },

    /**
     * By raw address. `ilike` rather than `eq`: Shopify lowercases what it
     * stores, but nothing guarantees the address a caller passes in was.
     */
    async findByEmail(email) {
      const address = String(email || '').trim();
      if (!address) {
        return null;
      }
      const rows = await supabaseSelectAll(
        supabase,
        'customers',
        {
          shop_id: shopId,
          deleted_at: { operator: 'is', value: 'null' },
          email: { operator: 'ilike', value: address }
        },
        COLUMNS
      );
      return rows[0] || null;
    },

    /** By `tickets.requester_email_hash`, without either side holding the address. */
    async findByEmailHash(emailHash) {
      const hash = String(emailHash || '').trim();
      if (!hash) {
        return null;
      }
      const index = await loadHashIndex();
      const customerId = index.get(hash);
      return customerId ? fetchById(customerId) : null;
    },

    /**
     * The tool proper: identity in, CRM bundle out.
     *
     * Accepts a ticket directly so the worker can hand over what it already has
     * rather than unpacking the hash itself. An explicit `email` wins over the
     * ticket, because a caller who supplies one is answering a question the
     * ticket could not.
     *
     * NOT FINDING A CUSTOMER IS A REAL ANSWER, not a failure. Somebody writing in
     * from an address that was never used to order is the ordinary case for a
     * pre-sales question, and `found: false` says so — as distinct from
     * `no_identifier`, which means the ticket carried nothing to search on and a
     * human should notice.
     */
    async lookupCustomer({ email = null, emailHash = null, ticket = null, includeEmail = false } = {}) {
      const hash = emailHash || ticket?.requester_email_hash || null;

      let customer = null;
      let matchedBy = null;

      if (email) {
        customer = await this.findByEmail(email);
        matchedBy = customer ? 'email' : null;
      }
      if (!customer && hash) {
        customer = await this.findByEmailHash(hash);
        matchedBy = customer ? 'email_hash' : null;
      }

      if (!email && !hash) {
        logger?.info?.('customer.lookup', { found: false, reason: 'no_identifier' });
        return {
          found: false,
          reason: 'no_identifier',
          matchedBy: null,
          customerId: null,
          customer: null,
          account: null,
          promptText: 'Aucune adresse e-mail exploitable sur ce ticket.'
        };
      }

      if (!customer) {
        logger?.info?.('customer.lookup', { found: false, reason: 'no_match' });
        return {
          found: false,
          reason: 'no_match',
          matchedBy: null,
          customerId: null,
          customer: null,
          account: null,
          promptText:
            'Aucun compte client ne correspond à cette adresse — ' +
            'la personne n’a jamais commandé avec cette adresse, ou a commandé sans créer de compte.'
        };
      }

      const context = buildCustomerContext(customer);
      const account = buildAccountState(customer);

      // Never the address, the name or the id — only the shape of what was found.
      logger?.info?.('customer.lookup', {
        found: true,
        matchedBy,
        ordersCount: context.ordersCount,
        rfmGroup: context.rfmGroup,
        accountState: account.state
      });

      await recordAccess(customer, matchedBy);

      return {
        found: true,
        matchedBy,
        // The row id, returned BESIDE the bundle and never inside it. A caller
        // that wants to persist the link (`tickets.customer_id`) needs it, but
        // `buildCustomerContext` is the exact shape stored in
        // `tickets.resolved_context.customer` — adding a field there would
        // rewrite every bundle written so far.
        customerId: customer.id,
        customer: context,
        account,
        promptText: toPromptText(context, account, { includeEmail })
      };
    }
  };
}

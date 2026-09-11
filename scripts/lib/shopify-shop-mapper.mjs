import { stripUndefined } from './collections.mjs';

// TWO DOMAINS, AND THEY ARE NOT INTERCHANGEABLE. `shop_domain` is the
// `*.myshopify.com` one: it is the shop's identity, it is what the unique
// constraint and every webhook key on, and no customer has ever seen it.
// `storefront_url` is where customers actually go — `https://qiriness.com` —
// and it is the only one a reply may ever contain.
//
// FETCHED RATHER THAN CONFIGURED, deliberately. A support reply that has to
// send somebody to their account page needs an address, and the alternative was
// a setting for an operator to type: a second copy of something Shopify already
// knows, wrong the day the domain changes and wrong silently.
export function mapShop(shop, config) {
  return {
    shopify_shop_id: shop.id,
    shop_domain: shop.myshopifyDomain || config.shopDomain,
    shop_name: shop.name,
    // Null rather than a guess when Shopify does not return it: a reply with no
    // link is worse than one with a link, and far better than one with a link
    // that 404s.
    storefront_url: shop.primaryDomain?.url || null,
    // `CLASSIC` means password accounts, so /account/login carries a « mot de
    // passe oublié » form. Under `NEW_CUSTOMER_ACCOUNTS` there is no password at
    // all — sign-in is a one-time emailed code — and every reply telling
    // somebody to reset one would be wrong. Recorded so that change is visible
    // rather than discovered from a customer's confusion.
    customer_accounts_version: shop.customerAccountsV2?.customerAccountsVersion || null,
    // The shop's own clock (`Europe/Paris`), which is where "a day" starts on
    // the Insights charts. Null when Shopify does not return it; the reader
    // falls back to UTC and says so, rather than guessing a zone.
    iana_timezone: shop.ianaTimezone || null,
    environment: config.appEnv,
    // NO `sync_cursors` AND NO `app_settings`, deliberately. Both are ours, not
    // Shopify's — `sync_cursors` holds the mail delta link — and both have a
    // `'{}'` column default for a first insert. Sending `{}` here made every
    // Shopify sync wipe the mail cursor, so each mail poll after a nightly sync
    // re-enumerated the whole mailbox. See DECISIONS.md § Ingestion.
    raw_shopify_payload: stripUndefined({
      id: shop.id,
      name: shop.name,
      myshopifyDomain: shop.myshopifyDomain,
      primaryDomain: shop.primaryDomain,
      customerAccountsV2: shop.customerAccountsV2,
      ianaTimezone: shop.ianaTimezone
    })
  };
}

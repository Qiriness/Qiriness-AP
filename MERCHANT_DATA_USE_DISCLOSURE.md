# Merchant Data Use Disclosure

This document explains how the Qiriness customer-support operating system processes Shopify data. It is written for merchant-facing disclosure and can later be adapted into app privacy copy.

## Purpose

The app synchronizes selected Shopify data into Supabase so Qiriness can operate an internal customer-support dashboard and support automation workflow. Shopify remains the source of truth.

## Data Processed

The app currently processes these Shopify data categories:

- Shop metadata: Shopify shop ID, shop domain, shop name, environment, app settings, and sync cursors.
- Product and metaobject data: product titles, handles, statuses, variants, structured product metafields, stock summary, product FAQ and ingredient metaobjects.
- Knowledge content: Shopify pages, policies, menus, and generated retrieval chunks for support context.
- Customer support fields: Shopify customer ID, legacy customer ID, display name, first name, last name, email, phone, locale, account state, email validity, tags, email marketing consent state, coarse default location, lifetime order count, lifetime amount spent, last-order summary, Shopify RFM group, and sanitized trace metadata.

The app does not intentionally store customer street address lines, postcode, customer notes, full raw customer payloads, Shopify tokens, or Supabase service-role keys in source code, logs, test fixtures, or documentation.

## Processing Purposes

Personal data is processed only for:

- customer support lookup and triage;
- support dashboard segmentation;
- identifying marketing consent state for support awareness;
- operational sync, reconciliation, and troubleshooting;
- privacy request and deletion handling;
- personalising the storefront beauty advisor for a signed-in customer, from their own past purchases (off unless the merchant switches it on; see below).
- telling a storefront visitor where an order stands when they give its order number (off unless the merchant switches it on; see below).

Marketing consent data is informational for support unless a future marketing workflow explicitly implements consent enforcement. The app does not sell customer data.

## Storage and Sync

Data is stored in Supabase PostgreSQL. Sync is one-way from Shopify to Supabase.

One database serves the Lap Groupe shops the dashboard is configured for (`DASHBOARD_SHOPS`; since 2026-10-26, Qiriness and Barbara Gould). Every shop's rows carry its `shop_id`, and every dashboard read and cached answer is scoped to one shop. Barbara Gould's data is used for the Insights dashboard only. The support desk, the AI agent and the storefront advisor process Qiriness's data alone.

The intended production schedule is one overnight sync per day, defaulting to `0 2 * * *` in `Europe/London`. Manual dry-run scripts remain available for development and troubleshooting.

Operational event tables store metadata only. They must not store raw webhook payloads, tokens, customer email addresses, phone numbers, or full addresses.

## Retention and Deletion

The retention source of truth is Shopify. Customer data is kept locally until Shopify sends a deletion/redaction request, a shop redaction request is received, or customer reconciliation determines that Shopify no longer returns the customer.

Order snapshots additionally carry a merchant-configured retention period (`shops.order_retention_mode`): a number of months after which they are deleted by the order sync, or `indefinite`. **This shop is currently set to `indefinite`**, so order snapshots are retained until one of the deletion paths above removes them. Shopify deletion and redaction requests take precedence over this setting in every case.

For Shopify `customers/redact`, the app hard deletes matching customer rows from Supabase.

For Shopify `shop/redact`, the app deletes the shop row, which cascades shop-scoped operational snapshots, while keeping metadata-only privacy request evidence with shop references cleared.

## Privacy Requests

The app handles Shopify mandatory compliance webhook topics:

- `customers/data_request`
- `customers/redact`
- `shop/redact`

Webhook signatures must be validated using Shopify HMAC verification before processing. Duplicate webhook deliveries are deduplicated through integration event keys.

Customer data request webhooks are recorded for merchant response handling. Redaction webhooks trigger database deletion behavior.

## AI Boundaries

AI workflows must retrieve context progressively. Customer personal data must not be included in AI prompts unless strictly required for a specific support task.

Product, policy, and knowledge content can be used as AI support context. Customer-specific data requires explicit task justification.

**Storefront advisor and order status.** When the merchant turns it on (`STOREFRONT_CHAT_ORDER_STATUS=on`; off by default), a visitor who gives an order number gets that order's status: being prepared, delayed, on its way, late, delivered or cancelled, with the day it was placed and shipped. The advisor's AI model sees only that, and the shop's dispatch and delivery policy; never a name, email address, phone number, address, amount, product or tracking number. The delivery country is read only to choose the shop's home or abroad delivery time. Order numbers are sequential, so a visitor could try numbers; this is why nothing about the person is returned, a conversation is limited to three lookups, marketplace orders are not answered, and every lookup is logged in `data_access_events` with a hashed reference.

**Storefront advisor and purchase history.** When the merchant turns it on (`STOREFRONT_CHAT_PURCHASE_HISTORY=on`; off by default), the storefront advisor may read the purchase history of the customer who is signed in to the store, and only theirs. Shopify's signed app proxy request identifies them; an email or order number typed in the chat is never used. The advisor's AI model then sees the products bought on the online store, the day of the last purchase, how many orders held each, and whether a product was returned or came free. It never sees names, email addresses, phone numbers, addresses, order numbers or amounts paid, and marketplace orders are excluded. A purchase is used to ask the customer about it (« are you still using it? »), never to decide their skin type or needs. Each read is logged in `data_access_events` with a hashed customer id. What the customer answers stays in the advisor's conversation log, which is purged after 30 days of inactivity.

## Access Controls

Supabase row-level security is enabled for operational and compliance tables. Until dashboard roles and policies are implemented, customer data access is treated as service-role-only sync and compliance processing.

Future dashboard users must use role-based access and write personal-data access events to `data_access_events`.

## Deferred Controls

The following controls are deferred for the current development phase and must not be represented as implemented:

- data loss prevention strategy;
- employee password policy;
- security incident response policy;
- third-party security reviews;
- third-party security certifications.

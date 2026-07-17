Plan
Supabase Architecture Plan
Summary
Use Supabase as a compact operational database for AI support context and dashboard workflows. Shopify remains the source of truth for products, orders, fulfilments, refunds, customers, and privacy events.

The MVP supports the three most common topics: orders/tracking, product information, and returns/refunds. Full raw email bodies and product images are not stored in Supabase by default.

Core Tables
shops: Shopify shop/environment records, sync cursors, and app integration state.
products: Shopify product records, structured product facts, variants as JSONB, and product-specific FAQs as structured JSONB.
knowledge_documents: general store FAQs, policies, pages, and company guidance synced from Shopify.
knowledge_chunks: AI retrieval chunks with embeddings, source table, source row, source fragment ID, and content hash.
customers: minimal support identity, Shopify customer ID when known, hashed email/name matching fields, and redaction status.
orders: compact Shopify order snapshot with order ID/name/number, customer link, status, financial status, fulfillment status, primary tracking fields, all tracking entries as JSONB, and refund/return summary JSONB.
support_threads: inbox thread state, category, priority, linked customer/order, order match confidence/source, missing-info state, and response status.
support_messages: provider message metadata, direction, redacted body, AI-safe summary, and provider message ID.
ai_events: classifications, retrieval references, draft outputs, approvals, sends, model version, and prompt version.
integration_events: metadata-only webhook/import/sync log with idempotency keys, topic, status, timestamps, and sanitized error summaries.
privacy_requests: Shopify data request/redaction tracking and completion audit.
Required Field Rules
products.product_faqs must be structured JSONB, not a loose blob. Each FAQ item includes faq_id, question, answer, Shopify source reference, content_hash, updated_at, and published.
orders stores primary tracking fields for fast dashboard/AI use, plus all fulfillment tracking entries in JSONB for multi-shipment orders.
orders.refund_return_summary exists in v1 so returns/refunds can be answered at a basic status level before full returns automation.
support_threads includes resolution_state, missing_info_type, order_match_source, and order_match_confidence.
knowledge_chunks always references an exact source row and source fragment so product FAQ updates, policy updates, and privacy redaction can remove stale derived content.
Email And Order Matching Workflow
When an email enters the inbox:

Store thread/message metadata, redacted body, and AI-safe summary.
Classify the email into MVP categories: orders/tracking, product info, returns/refunds, or general.
Attempt order linking using exact order number, exact tracking number, Shopify customer ID, hashed email, then hashed name.
Exact order number and exact tracking number are high-confidence matches.
Shopify customer ID plus recent order context is medium/high confidence.
Email hash is medium confidence.
Name-only matching is low confidence and must not expose order details automatically.
If order or tracking data is missing or ambiguous, set missing_info_type and have the AI agent ask for the needed order number, tracking number, or identifying detail.
Once the customer provides reliable order/tracking information, update the linked orders record and thread match fields.
Privacy And Retention
Implement Shopify compliance webhook handling for customers/data_request, customers/redact, and shop/redact.
On customer redaction, anonymize or purge PII from customers, orders, support_threads, support_messages, ai_events, knowledge_chunks derived from customer conversations, and integration_events.
Treat derived AI artifacts as customer data when they contain or summarize customer-specific information.
Keep integration_events metadata-only by default. Raw payload retention is not part of v1 unless a later explicit retention policy is approved.
Preserve only non-identifying operational metrics such as category, priority, status, timestamps, and response outcome.
Test Plan
Migration tests for tables, indexes, foreign keys, RLS, and pgvector.
Shopify sync tests for products, structured product FAQs, general FAQs/policies, orders, tracking, and refund/return summaries.
Email ingestion tests for redaction, category classification, order matching, and missing-info states.
Privacy tests proving customer and shop redaction remove direct and derived customer data idempotently.
AI retrieval tests proving product-specific FAQs, general policies, and linked order context are retrieved correctly while deleted customer data is excluded.
Assumptions
Product-specific FAQs are stored on products; general FAQs and policies are stored in knowledge_documents.
No product images are imported into Supabase in v1.
Full raw email bodies remain in the email provider and are fetched only when strictly required.
The dashboard MVP focuses on email queue, category, priority, linked order/tracking, and response workflow.
<!-- Part of DECISIONS.md (the index). Moved here verbatim on 2026-10-12; headings unchanged, so "DECISIONS.md § <heading>" references resolve with grep. -->

## Customer resolution

Runs as soon as the mail is stored and **before every LLM pass**: identity is what a ticket has from its first message, so it waits on nothing — no category, no order number, no OpenAI key. It calls the CRM lookup with `tickets.requester_email_hash` and writes `tickets.customer_id`, which was previously only ever set as a by-product of a confirmed order number — leaving every account question, pre-sales enquiry and contact-form message permanently unlinked.

**The hash it keys on is the address the customer typed**, because ingestion already replaced the contact form's `mailer@shopify.com` envelope with the form's own `E-mail` field. Nothing here re-derives identity from the envelope.

Three rules make it safe to run every minute:

1. A small denylist of **notification senders** (Shopify's mailers, plus the support mailbox) is refused outright and never retried — a contact-form body that fails to parse leaves one of those as the requester, and linking them would give every such ticket the same wrong customer.
2. A `no_match` is a real answer that is nonetheless **re-asked once a day**: customers arrive from the nightly sync, and today's stranger is next week's buyer.
3. Every outcome, match or not, is recorded in `metadata.customer_resolution` with the hash it was tried against — so a re-parse or a backfilled requester re-opens the question immediately while an unchanged one stays quiet.

The lookup's process-wide hash index is dropped once per pass that has work, so a customer synced since startup is visible.

### `customer_id` has two writers and one meaning

The customer-resolution pass links it from the requester's own address on any ticket; order-context links it from a confirmed order. The second never overwrites a value already there, and both are keyed on the same requester hash, so they agree by construction.

### An address given when we asked for one may link the customer (2026-10-02)

A third way in, decided by the user after the audit below: when the sender's own address finds nobody, customer resolution reads the customer's own words in inbound messages received **after** the first case-state reading that put `account_email` or `purchase_email` in `pending_customer_inputs` (`record.addressAnswersByTicket`). If the addresses there lead to **exactly one** customer, the ticket is linked, `matched_by: reply_email`.

**Only after we asked**, which is the safer of the two versions offered. An address that merely appears in a thread is a forward, a signature or a colleague: the 7 unlinked tickets carrying a known customer's address in a later message on 2026-10-02 were all staff forwards. **Exactly one**, because « j'ai deux adresses » is what the account question was written for, and two customers is a question for a person. **The sender's own address still wins.**

A new message since the last attempt re-runs the ticket at once instead of after the 24-hour back-off (`last_message_at`), or the answer would wait a day while the customer was asked again.

**`lookupCustomer` falls back to `tickets.customer_id`** when the sender's address finds nobody (`matchedBy: customer_id`). Without it a ticket linked by a confirmed order or by a reply still told the model « aucune fiche client… c'est la question à lui poser ». This is the one place the two meanings above can differ: an order confirmed through `message_email` links its buyer, who may not be the sender.

Replayed on the test ticket `c3efeb4e` as if unlinked, it links the customer that had been linked by hand. On live data, no unlinked ticket qualifies today.

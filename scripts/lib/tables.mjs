/**
 * The database schema, named once.
 *
 * WHY THIS EXISTS. Before this module the schema was quoted as string literals
 * in 65 files across all three packages — 217 table names and a column list at
 * almost every call site. Nothing checked them: PostgREST answers a request for
 * a column that does not exist with an error at runtime, on the one code path
 * that asked, and a table rename was a codebase-wide sweep with no compiler and
 * no test behind it.
 *
 * Two things live here and nothing else:
 *
 *   T        — every table and view the baseline creates.
 *   COLUMNS  — the projections that are asked for in more than one place, or
 *              that carry a rule worth stating once.
 *
 * A projection used in exactly one place stays at its call site, next to the
 * comment explaining why it reads those columns. This module is not an index of
 * every select in the codebase; it is the set of names that would otherwise
 * drift apart.
 *
 * `_shared.test.mjs` asserts both halves against the .sql files: every name in
 * `T` is created by the baseline, and every column in `COLUMNS` exists on the
 * table it projects. A rename that misses a call site now fails the suite
 * instead of failing in production.
 */

/**
 * Tables, by the file that creates them. The grouping is the apply order, which
 * is also the dependency chain — see `supabase/migrations/`.
 */
export const T = {
  // 01_foundation
  SHOPS: 'shops',
  INTEGRATION_EVENTS: 'integration_events',
  PRIVACY_REQUESTS: 'privacy_requests',
  DATA_ACCESS_EVENTS: 'data_access_events',

  // 02_shopify
  CUSTOMERS: 'customers',
  ORDERS: 'orders',
  PRODUCTS: 'products',
  SHOPIFY_METAOBJECTS: 'shopify_metaobjects',
  PROMOTIONS: 'promotions',
  SHOPIFY_CONTENT_SOURCES: 'shopify_content_sources',

  // 03_knowledge
  KNOWLEDGE_DOCUMENTS: 'knowledge_documents',
  KNOWLEDGE_CHUNKS: 'knowledge_chunks',

  // 04_support
  TICKETS: 'tickets',
  TICKET_MESSAGES: 'ticket_messages',
  EMAIL_BLOCKLIST: 'email_blocklist',
  SENDER_DIRECTORY: 'sender_directory',
  SPAM_AUDIT: 'spam_audit',
  TICKET_INVESTIGATIONS: 'ticket_investigations',
  CATEGORY_FORWARDING: 'category_forwarding',
  TICKET_FORWARDS: 'ticket_forwards',
  CATEGORISATION_REVIEW: 'categorisation_review',

  // 05_exemplars
  SUPPORT_EXEMPLARS: 'support_exemplars',
  SUPPORT_EXEMPLAR_PHRASINGS: 'support_exemplar_phrasings',
  SUPPORT_ANSWERS: 'support_answers',
  SUPPORT_PARAMETERS: 'support_parameters',

  // 06_analytics
  LLM_USAGE: 'llm_usage',
  CLUSTER_RUNS: 'cluster_runs',
  TICKET_CLUSTERS: 'ticket_clusters',

  // 07_drafting
  TICKET_DRAFTS: 'ticket_drafts',
  TICKET_DRAFT_EDITS: 'ticket_draft_edits',

  // 08_testing
  AGENT_TEST_RUNS: 'agent_test_runs'
};

/**
 * The management chat's log tables. Created by the INCREMENTAL migration
 * `17_management_chat.sql`, not the baseline, so they are kept out of `T` —
 * `_shared.test.mjs` asserts `T` names exactly what the baseline creates.
 * `17_management_chat.test.mjs` asserts these instead.
 */
export const CHAT_T = {
  CONVERSATIONS: 'chat_conversations',
  TURNS: 'chat_turns',
  QUERIES: 'chat_queries'
};

/**
 * Views. Selected from exactly like tables through PostgREST, and listed apart
 * because they are read-only: a write to one of these names is a mistake the
 * database will reject, and naming them separately makes that visible here.
 */
export const V = {
  // 04_support
  TICKET_MESSAGE_COUNTS: 'ticket_message_counts',
  TICKET_FIRST_INBOUND: 'ticket_first_inbound',
  TICKET_QUEUE: 'ticket_queue',

  // 06_analytics — every Insights panel figure comes from one of these, because
  // a dashboard that pages rows and reduces them in JavaScript is wrong twice
  // over (PostgREST's 1,000-row cap, and unordered pages that overlap).
  ORDER_FULFILMENT_TIMING: 'order_fulfilment_timing',
  FULFILMENT_SUMMARY: 'fulfilment_summary',
  FULFILMENT_BY_MONTH: 'fulfilment_by_month',
  FULFILMENT_BY_CARRIER: 'fulfilment_by_carrier',
  FULFILMENT_TICKET_COVERAGE: 'fulfilment_ticket_coverage',
  FULFILMENT_BY_BUCKET: 'fulfilment_by_bucket',
  // The same three cut by sales channel. Additive rather than a channel column
  // on the views above, which stay one row per shop for the whole book.
  FULFILMENT_SUMMARY_BY_CHANNEL: 'fulfilment_summary_by_channel',
  FULFILMENT_BY_CHANNEL_MONTH: 'fulfilment_by_channel_month',
  FULFILMENT_BY_CHANNEL_BUCKET: 'fulfilment_by_channel_bucket',
  TICKET_REPLY_TIMES: 'ticket_reply_times',
  SUPPORT_BY_MONTH: 'support_by_month',
  SUPPORT_BY_CATEGORY: 'support_by_category',
  SUPPORT_PURCHASE_STATES: 'support_purchase_states',
  SUPPORT_PURCHASE_BY_CATEGORY: 'support_purchase_by_category',
  CUSTOMER_TICKET_FACTS: 'customer_ticket_facts',
  CUSTOMER_SEGMENT_TOTALS: 'customer_segment_totals',
  INVESTIGATION_EVIDENCE_GAPS: 'investigation_evidence_gaps',
  AGENT_PIPELINE_FUNNEL: 'agent_pipeline_funnel',
  INVESTIGATION_VERDICTS: 'investigation_verdicts',
  LLM_USAGE_BY_MONTH: 'llm_usage_by_month',
  LLM_USAGE_SUMMARY: 'llm_usage_summary'
};

/** Postgres functions reached through PostgREST's /rpc endpoint. */
export const RPC = {
  MATCH_KNOWLEDGE_CHUNKS: 'match_knowledge_chunks',
  SEARCH_KNOWLEDGE_CHUNKS_TEXT: 'search_knowledge_chunks_text',
  MATCH_SUPPORT_EXEMPLARS: 'match_support_exemplars',
  ORDER_NUMBER_RANGE: 'order_number_range',

  // 06_analytics — the Insights panels over a date range. Every one takes the
  // range as wall-clock timestamps plus the shop's timezone; see the header of
  // the RANGED READS section for the convention.
  INSIGHTS_ORDERS_SUMMARY: 'insights_orders_summary',
  INSIGHTS_ORDERS_SERIES: 'insights_orders_series',
  INSIGHTS_ORDERS_BY_CHANNEL: 'insights_orders_by_channel',
  INSIGHTS_CUSTOMER_MIX: 'insights_customer_mix',
  INSIGHTS_FULFILMENT_BUCKETS: 'insights_fulfilment_buckets',
  INSIGHTS_FULFILMENT_CARRIERS: 'insights_fulfilment_carriers',
  INSIGHTS_PRODUCT_SALES: 'insights_product_sales',
  INSIGHTS_PRODUCT_CUSTOMER_MIX: 'insights_product_customer_mix',
  INSIGHTS_COUNTRY_PRODUCT_SALES: 'insights_country_product_sales',
  INSIGHTS_SUPPORT_SUMMARY: 'insights_support_summary',
  INSIGHTS_SUPPORT_SERIES: 'insights_support_series',
  INSIGHTS_SUPPORT_CATEGORIES: 'insights_support_categories',
  INSIGHTS_AGENT_FUNNEL: 'insights_agent_funnel',
  INSIGHTS_AGENT_VERDICTS: 'insights_agent_verdicts',
  INSIGHTS_AGENT_BLOCKERS: 'insights_agent_blockers',
  INSIGHTS_LLM_USAGE: 'insights_llm_usage',
  INSIGHTS_LLM_SERIES: 'insights_llm_series',
  INSIGHTS_LLM_TICKET_STATS: 'insights_llm_ticket_stats',
  INSIGHTS_FRESHNESS: 'insights_freshness',
  INSIGHTS_ORDERS_BY_COUNTRY: 'insights_orders_by_country',
  INSIGHTS_PRODUCT_PAIRS: 'insights_product_pairs',
  INSIGHTS_ORDERS_PER_CUSTOMER: 'insights_orders_per_customer',
  INSIGHTS_MARKETING_SERIES: 'insights_marketing_series',
  INSIGHTS_MARKETING_SUMMARY: 'insights_marketing_summary',
  INSIGHTS_CAPTURE_SERIES: 'insights_capture_series',

  // 06_analytics — THE VIP RULE. vip_customers() is the one place it is written;
  // the thresholds come from shops via scripts/lib/vip-rule.mjs.
  VIP_CUSTOMERS: 'vip_customers',
  VIP_TICKETS: 'vip_tickets',
  VIP_SUMMARY: 'vip_summary',
  // Orders waiting to ship, each marked VIP through vip_customers().
  OPEN_ORDERS: 'open_orders',
  // The Orders page: one page of every order, and its filter options.
  ORDERS_LIST: 'orders_list',
  ORDERS_LIST_FACETS: 'orders_list_facets',
  // The Customers panel's Segment Finder: OR-of-AND conditions over orders and spend.
  CUSTOMER_SEGMENT_FIND: 'customer_segment_find'
};

/**
 * The recurring projections.
 *
 * Each is the answer to "what does this reader need", not "what does this table
 * hold" — a `select *` would be shorter and is deliberately not used: the
 * largest columns here are email bodies and 1536-float vectors, and a reader
 * that names its columns cannot accidentally start shipping them.
 */
export const COLUMNS = {
  /**
   * The queue row, read from the `ticket_queue` view.
   *
   * ONE PROJECTION FOR THE LIST READ AND THE STATUS WRITE, so the two cannot
   * drift: the row a mutation returns replaces a row the list rendered, and a
   * narrower shape would blank whatever the list had shown.
   */
  // `requester_email` is here so the caller can ask `sender_directory` whether a
  // thread was opened by a customer or by one of our own. It is resolved to a
  // label server-side and never reaches the browser — see `mapTicketRow`.
  ticketQueue:
    'id,subject,status,category,secondary_category,level,happiness,responsible_team,' +
    'requester_name,requester_email,shopify_order_number,first_message_at,last_message_at,' +
    'duplicate_of_ticket_id,duplicate_reason,sender_label,' +
    'customer_display_name,customer_first_name,customer_last_name,customer_rfm_group,' +
    'message_count,inbound_count,waiting_since',

  /** What the categoriser needs: the previous reading, to ratchet against. */
  ticketForCategorisation: 'id,subject,metadata,category,request_kind,level,happiness',

  /** What the investigation needs to choose its tools and open a case file. */
  // `status` is here for one reason: a deliberate re-run over closed threads
  // (`investigate --include-closed`) must write the case file without moving the
  // ticket, and the runner cannot tell an open ticket from a closed one it was
  // handed unless the column comes back with it.
  ticketForInvestigation:
    'id,subject,status,category,request_kind,level,customer_id,requester_email_hash,' +
    'shopify_order_number,resolved_context,metadata,duplicate_of_ticket_id',

  /** Customer resolution: an address hash and somewhere to record the attempt. */
  ticketForCustomerResolution: 'id,customer_id,requester_email_hash,metadata',

  /** Order resolution: the text is joined from `ticket_first_inbound` separately. */
  ticketForOrderResolution:
    'id,subject,category,request_kind,requester_email_hash,requester_name,metadata',

  /** Order context: which order to build a bundle for, and whether one exists. */
  ticketForOrderContext: 'id,subject,shopify_order_number,customer_id,context_resolved_at',

  /**
   * What drafting needs off the ticket.
   *
   * `happiness` travels beside `level` because the auto-send gate reads both —
   * a level 1 question asked furiously is still the wrong one to answer without
   * a person seeing it. `categorisation_confidence` is deliberately absent: it
   * is only ever written by failure paths, so gating on it would read "the
   * categoriser crashed" as "the categoriser was unsure".
   */
  // `duplicate_of_ticket_id` travels so the pass can skip a ticket linked as a
  // duplicate — the whole point of the link is that one customer does not get
  // two replies to one message.
  ticketForDrafting:
    'id,subject,status,level,language,happiness,requester_name,resolved_context,' +
    'duplicate_of_ticket_id,related_ticket_id,related_score,sender_label',

  /**
   * Auto-close. `needs_categorisation` is read so a ticket still queued for the
   * categoriser is not closed out of that queue — see auto-close.mjs.
   */
  ticketForAutoClose:
    'id,status,level,last_message_at,subject,deleted_at,metadata,needs_categorisation',

  /**
   * Ingestion's view of an existing thread. `status` is read so a reply can
   * reopen a ticket auto-close retired.
   */
  ticketForConversation:
    'id,status,subject,first_message_at,last_message_at,requester_email_hash,requester_name',

  /** The dashboard's detail panel reads the bundle, not the whole row. */
  ticketForDetail: 'id,resolved_context',

  /** The thread dialog: envelope and body, both directions. */
  messageForThread:
    'id,direction,from_name,from_email,subject,body_text,has_attachments,received_at,sent_at',

  /** The categoriser reads the customer's words and nothing else. */
  messageForCategorisation: 'subject,body_text,received_at',

  /**
   * What the detail panel needs to say what the customer attached.
   *
   * `body_text` TRAVELS, and it is the one debatable field here: the thread
   * dialog exists precisely so bodies are not fetched on every row expansion.
   * It is here because the panel's second signal — "they said « ci-joint » and
   * nothing arrived", 74 tickets against 16 that carry a real photo — is read
   * out of the words and nowhere else. Measured before deciding: bodies are
   * 3.2 KB per ticket on average and 38 KB at the worst, against a case-file
   * row the same read already fetches. `body_preview` would have been smaller
   * and would miss a « ci-joint » past the first line, which is where it
   * usually sits.
   *
   * No addresses and no subject: who sent it is already on the ticket, and the
   * panel is answering "what is attached", not "who is this".
   *
   * `graph_message_id` travels because it is half the address of an attachment:
   * Graph fetches bytes as (message, attachment id), and the panel's proxy has
   * no other way to say which message a listed part belongs to.
   */
  messageForAttachments: 'direction,graph_message_id,body_text,has_attachments,attachments',

  /**
   * The thread's SHAPE, for deciding whether the customer was left waiting.
   *
   * Directions and timestamps only — no bodies and no addresses. The question is
   * "did they write again before we answered", which is answered by the order of
   * the envelopes; pulling the bodies to answer it would ship every email in the
   * thread to a pass that reads one.
   */
  messageEnvelopesForDrafting: 'ticket_id,direction,received_at,sent_at',

  /**
   * Drafting reads the message it is replying to, and nothing about who sent it.
   *
   * No `from_email` and no `from_name`: the reply is composed from the case
   * file, and the one piece of identity it needs to open properly
   * (`requester_name`) already travels on the ticket. An address in the prompt
   * is an address the model can quote back.
   */
  messageForDrafting: 'id,subject,body_text',

  /**
   * The investigation additionally reads `from_email` for the sender-directory
   * lookup (never prompted — only the label it resolves to is), and `embedding`
   * so exemplar matching reuses the vector ingestion already wrote.
   */
  // `has_attachments` AND `attachments` both travel: the boolean says something
  // is attached, the array says what it is, and an empty array under a true
  // boolean means "ingested before the metadata fetch existed" rather than
  // "nothing attached". The photo-evidence check needs to tell those apart.
  messageForInvestigation:
    'id,subject,body_text,received_at,from_email,embedding,has_attachments,attachments',

  /** The case file, latest run, as the detail panel reads it. */
  // `candidate_order` travels HERE and deliberately not in
  // `investigationForDrafting`: it is the order a human should check first, and
  // a number a model can see is a number it can quote.
  //
  // `reaction_report` follows the same split for a different reason. A reply
  // that needs to name the product already has it as an ESTABLISHED FACT, cited
  // to the tool call that resolved it; this column is the same information
  // without that verification step attached, and a drafting projection carrying
  // both would offer a model the unchecked copy beside the checked one.
  investigationForDetail:
    'verdict,established,unverified,missing,handoff,candidate_order,reaction_report,investigated_at,evidence_gaps',

  /**
   * The case file as the drafting pass reads it back.
   *
   * `tool_calls` and `dropped_claims` are ABSENT, and their absence is the same
   * guarantee `toDraftingPrompt` makes one layer up: internal notes reaching a
   * customer reply is the failure that split exists to make impossible, and not
   * selecting them is cheaper than trusting a renderer not to print them.
   * `investigated_at` travels because the newest reading of a ticket is the only
   * one worth drafting.
   *
   * `handoff` IS SELECTED, and it is the one exception worth stating. The
   * draft's `disposition` turns on whether a human owes an action, which is
   * exactly what a handoff records — and getting it wrong closes a ticket
   * somebody still owes work on. The store reduces it to a boolean the moment it
   * arrives (`draft-runner.mjs`), so the internal prose exists for one line and
   * never reaches the runner or the prompt.
   *
   * `exemplar_match` TRAVELS FOR ONE FIELD INSIDE IT: `policy.answer_skeleton`,
   * the wording guidance a matched rule carries. The rest of that object is
   * diagnostic — similarity, margin, the runner-up, the resolved findings — and
   * `caseFileFromRow` reads only the skeleton out of it, so nothing else in
   * there can reach a prompt. Selecting the column and narrowing in the mapper
   * is the cheaper half of the guarantee `tool_calls` gets by being absent:
   * there is no second copy of the skeleton to keep in step with this one.
   */
  investigationForDrafting:
    'id,ticket_id,trigger_message_id,verdict,established,unverified,missing,do_not_claim,' +
    'knowledge,handoff,investigated_at,exemplar_match',

  /**
   * A draft as both readers need it: the dashboard rendering it for approval,
   * and the review-mail pass rendering it into an email to the reviewer.
   *
   * ONE PROJECTION FOR BOTH, so the two cannot show different things — the
   * whole point of the review copy is that it is the draft the dashboard holds.
   * `prompt_inputs` is absent: it is a debugging record of what went into the
   * call, not part of the reply, and it is the largest column here.
   */
  draftForReview:
    'id,ticket_id,trigger_message_id,source_verdict,disposition,level,language,subject,' +
    'body_text,approved_body_text,status,checks,checks_passed,auto_send_eligible,model,' +
    'drafted_at,review_sent_at',

  /**
   * The rehearsal history list, WITHOUT the trace.
   *
   * `trace` is by far the largest column in the schema after a message body --
   * every model call's prompt and every tool's returned text -- and the history
   * pane shows a row per run. Reading it to render a one-line summary would
   * pull megabytes to display kilobytes, which is the mistake the flat columns
   * on that table exist to prevent.
   */
  testRunForList:
    'id,ran_at,status,subject,body_text,requester_email_masked,order_number,' +
    'expect_document_id,article_verdict,gate_outcome,category,request_kind,level,language,' +
    'verdict,draft_skipped_reason,draft_checks_passed,ideal_body_text,total_tokens',

  /** One run, opened: the list columns plus the record itself. */
  testRunForDetail:
    'id,ran_at,status,subject,body_text,requester_name,requester_email_masked,order_number,' +
    'expect_document_id,article_verdict,gate_outcome,category,request_kind,level,language,' +
    'verdict,draft_body_text,draft_skipped_reason,draft_checks_passed,draft_disposition,' +
    'ideal_body_text,ideal_saved_at,trace,input_tokens,output_tokens,total_tokens,call_count,' +
    'failed_pass,error_message',

  /**
   * Everything `buildOrderContext` reads to assemble an order bundle.
   *
   * ONE LIST, TWO CALLERS, and the second is why it moved here. The order-context
   * pass builds a bundle for a CONFIRMED order; the purchase check builds one for
   * the customer's LAST order when none was confirmed. Both hand the row to the
   * same builder, so a column added for one and missed by the other would produce
   * two bundles of different shapes from one function.
   */
  orderForContext:
    'id,name,order_number,customer_id,' +
    'financial_status,fulfillment_status,return_status,order_status,' +
    'cancel_reason,cancelled_at,sales_channel,source_name,' +
    'currency_code,subtotal_price,total_discounts,total_shipping_price,' +
    'total_tax,total_price,total_refunded,total_outstanding,' +
    'line_items,fulfillments,refunds,returns,shipping_destination,' +
    // Read for the dashboard's benefit, not the agent's — `toOrderContextText`
    // leaves it out of what the model is shown.
    'customer_email_masked,' +
    'delivered_at,return_refund_opened_at,return_refund_completed_at,' +
    'processed_at,shopify_created_at,shopify_updated_at',

  /**
   * The embedding determinism quadruple, plus whatever composes the input.
   *
   * The three embedded tables carry the SAME four vector columns by design
   * (see DECISIONS.md § Embeddings); listing them here is what lets one
   * reconciler serve all three.
   */
  chunkForEmbedding:
    'id,section_heading,category,chunk_text,' +
    'embedding,embedding_model,embedding_dimensions,embedded_input_hash',
  phrasingForEmbedding:
    'id,phrasing_text,embedding,embedding_model,embedding_dimensions,embedded_input_hash',
  messageForEmbedding:
    'id,subject,body_text,embedding,embedding_model,embedding_dimensions,embedded_input_hash'
};

/**
 * Which table each projection is asserted against.
 *
 * Kept beside the projections rather than inferred from the names: `ticketQueue`
 * reads a view and `messageForEmbedding` reads `ticket_messages`, so a
 * name-prefix rule would be wrong for both.
 */
export const PROJECTION_SOURCE = {
  ticketQueue: V.TICKET_QUEUE,
  ticketForCategorisation: T.TICKETS,
  ticketForInvestigation: T.TICKETS,
  ticketForCustomerResolution: T.TICKETS,
  ticketForOrderResolution: T.TICKETS,
  ticketForOrderContext: T.TICKETS,
  ticketForAutoClose: T.TICKETS,
  ticketForConversation: T.TICKETS,
  ticketForDetail: T.TICKETS,
  orderForContext: T.ORDERS,
  ticketForDrafting: T.TICKETS,
  messageForThread: T.TICKET_MESSAGES,
  messageForCategorisation: T.TICKET_MESSAGES,
  messageForAttachments: T.TICKET_MESSAGES,
  messageForInvestigation: T.TICKET_MESSAGES,
  messageForDrafting: T.TICKET_MESSAGES,
  messageEnvelopesForDrafting: T.TICKET_MESSAGES,
  investigationForDetail: T.TICKET_INVESTIGATIONS,
  investigationForDrafting: T.TICKET_INVESTIGATIONS,
  draftForReview: T.TICKET_DRAFTS,
  testRunForList: T.AGENT_TEST_RUNS,
  testRunForDetail: T.AGENT_TEST_RUNS,
  chunkForEmbedding: T.KNOWLEDGE_CHUNKS,
  phrasingForEmbedding: T.SUPPORT_EXEMPLAR_PHRASINGS,
  messageForEmbedding: T.TICKET_MESSAGES
};

/** The four columns every embedded table carries, in one place. */
export const VECTOR_COLUMNS = [
  'embedding',
  'embedding_model',
  'embedding_dimensions',
  'embedded_input_hash'
];

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

  // 06_analytics
  LLM_USAGE: 'llm_usage',
  CLUSTER_RUNS: 'cluster_runs',
  TICKET_CLUSTERS: 'ticket_clusters'
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
  ORDER_NUMBER_RANGE: 'order_number_range'
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
  ticketQueue:
    'id,subject,status,category,secondary_category,level,happiness,responsible_team,' +
    'requester_name,shopify_order_number,first_message_at,last_message_at,' +
    'customer_display_name,customer_first_name,customer_last_name,customer_rfm_group,' +
    'message_count,inbound_count,waiting_since',

  /** What the categoriser needs: the previous reading, to ratchet against. */
  ticketForCategorisation: 'id,subject,metadata,category,request_kind,level,happiness',

  /** What the investigation needs to choose its tools and open a case file. */
  ticketForInvestigation:
    'id,subject,category,request_kind,level,customer_id,requester_email_hash,' +
    'shopify_order_number,resolved_context,metadata',

  /** Customer resolution: an address hash and somewhere to record the attempt. */
  ticketForCustomerResolution: 'id,customer_id,requester_email_hash,metadata',

  /** Order resolution: the text is joined from `ticket_first_inbound` separately. */
  ticketForOrderResolution:
    'id,subject,category,request_kind,requester_email_hash,requester_name,metadata',

  /** Order context: which order to build a bundle for, and whether one exists. */
  ticketForOrderContext: 'id,subject,shopify_order_number,customer_id,context_resolved_at',

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
  investigationForDetail:
    'verdict,established,unverified,missing,handoff,investigated_at,evidence_gaps',

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
  messageForThread: T.TICKET_MESSAGES,
  messageForCategorisation: T.TICKET_MESSAGES,
  messageForInvestigation: T.TICKET_MESSAGES,
  investigationForDetail: T.TICKET_INVESTIGATIONS,
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

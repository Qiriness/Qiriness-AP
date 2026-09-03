import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONFIDENCE_LEVELS,
  HAPPINESS_SCORES,
  REPLY_LANGUAGES,
  REQUEST_KINDS,
  TICKET_SUBJECTS,
  defaultLevel
} from '../../scripts/lib/support-taxonomy.mjs';
import { VERDICTS } from '../../agent/src/investigation/case-file.mjs';
import { checkClause, columnCheck, literalsIn, read, tablesIn } from './_shared.test.mjs';

const sql = read('04_support');

const clauseFor = (name) => {
  const clause = checkClause(sql, name);
  assert.ok(clause, `constraint ${name} is missing`);
  return clause;
};

test('creates exactly the nine tables it documents', () => {
  assert.deepEqual(tablesIn(sql).sort(), [
    'categorisation_review',
    'category_forwarding',
    'email_blocklist',
    'sender_directory',
    'spam_audit',
    'ticket_forwards',
    'ticket_investigations',
    'ticket_messages',
    'tickets'
  ]);
});

test('sender_directory matches the blocklist pattern shape and constrains its labels', () => {
  // Same two pattern types as email_blocklist, because the same matcher reads both.
  assert.deepEqual(literalsIn(clauseFor('sender_directory_pattern_type_check')).sort(), [
    'domain',
    'email'
  ]);
  // Constrained on purpose: the clustering filter compares against these strings,
  // so a free-text column would let a typo silently stop excluding a domain.
  assert.deepEqual(literalsIn(clauseFor('sender_directory_label_check')).sort(), [
    'contractor',
    'courier',
    'distributor',
    'internal',
    'logistics',
    'other',
    'partner',
    'retailer',
    'supplier'
  ]);
  // One row per (shop, type, pattern): re-seeding must update, never duplicate.
  assert.match(sql, /constraint sender_directory_shop_pattern_unique unique \(shop_id, pattern_type, pattern\)/);
  // `note` is context, not classification — it must stay nullable and unconstrained.
  assert.ok(!columnCheck(sql, 'sender_directory', 'note'));
});

test('the internal dependency chain is in creation order', () => {
  const at = (t) => sql.indexOf(`create table public.${t}`);
  assert.ok(at('tickets') < at('ticket_messages'));
  assert.ok(at('ticket_messages') < at('ticket_investigations'));
  // spam_audit carries an FK to a blocklist rule.
  assert.ok(at('email_blocklist') < at('spam_audit'));
  assert.ok(at('ticket_messages') < at('ticket_forwards'));
});

// --- the taxonomy, shared with 03 and support-taxonomy.mjs ------------------

test('both subject columns are constrained to the 14 ticket subjects only', () => {
  for (const name of ['tickets_category_check', 'tickets_secondary_category_check']) {
    assert.deepEqual(literalsIn(clauseFor(name)), [...TICKET_SUBJECTS].sort(), name);
  }
});

test('both kind columns are constrained to the four kinds', () => {
  for (const name of ['tickets_request_kind_check', 'tickets_secondary_request_kind_check']) {
    assert.deepEqual(literalsIn(clauseFor(name)), [...REQUEST_KINDS].sort(), name);
  }
});

test('a secondary kind without a secondary subject is forbidden', () => {
  // The subject is what the kind qualifies; a kind alone says nothing.
  assert.match(
    sql,
    /constraint tickets_secondary_pair_check check \(\s*secondary_request_kind is null or secondary_category is not null\s*\)/i
  );
});

test('confidence, language and happiness match the shared vocabularies', () => {
  assert.deepEqual(
    literalsIn(clauseFor('tickets_categorisation_confidence_check')),
    [...CONFIDENCE_LEVELS].sort()
  );
  assert.deepEqual(
    literalsIn(clauseFor('tickets_language_check')),
    [...REPLY_LANGUAGES].sort()
  );
  assert.match(clauseFor('tickets_happiness_check'), /between 1 and 4/i);
  assert.deepEqual(HAPPINESS_SCORES, [1, 2, 3, 4]);
});

test('the documented rule matches the code: no subject derives level 4', () => {
  // Level 4 is a severity judgement read from the email, never implied by a
  // topic. If a pair ever derived it, the manager queue would fill with routine
  // mail and the column comment here would be a lie.
  for (const subject of TICKET_SUBJECTS) {
    for (const kind of REQUEST_KINDS) {
      assert.notEqual(defaultLevel(subject, kind), 4, `${subject}/${kind}`);
    }
  }
  assert.match(sql, /comment on column public\.tickets\.level is/i);
});

// --- the ticket model -------------------------------------------------------

test('a ticket is a conversation: one per Graph conversationId per shop', () => {
  assert.match(sql, /constraint tickets_shop_conversation_unique unique \(shop_id, graph_conversation_id\)/i);
});

test('ticket status covers the draft-only lifecycle including spam', () => {
  const listed = literalsIn(clauseFor('tickets_status_check'));
  assert.deepEqual(listed, [
    'awaiting_customer', 'awaiting_human', 'closed', 'forwarded', 'open', 'resolved', 'spam'
  ]);
});

test('ticket level and priority are bounded', () => {
  assert.match(sql, /constraint tickets_level_check check \(level is null or level between 1 and 4\)/i);
  assert.match(sql, /constraint tickets_priority_check check \(priority between 1 and 5\)/i);
});

test('responsible_team is the four teams plus contact', () => {
  const listed = literalsIn(clauseFor('tickets_responsible_team_check'));
  assert.deepEqual(listed, ['contact', 'finance', 'logistics', 'marketing', 'sales']);
});

test('the ticket row minimises personal data; raw addresses live on messages', () => {
  const body = sql.split('create table public.tickets')[1].split('\n);')[0];
  assert.match(body, /requester_email_hash text/i);
  assert.doesNotMatch(body, /^\s*requester_email text/im);
});

test('the two queue flags default in opposite directions, deliberately', () => {
  // A new ticket is pending categorisation by construction; it is NOT pending
  // investigation, because without a subject there are no tools to choose.
  assert.match(sql, /needs_categorisation boolean not null default true/i);
  assert.match(sql, /needs_investigation boolean not null default false/i);
});

test('both queue indexes are partial, so they only carry pending rows', () => {
  assert.match(sql, /create index tickets_pending_categorisation_idx[\s\S]*?where[\s\S]*?needs_categorisation/i);
  assert.match(sql, /create index tickets_needs_investigation_idx[\s\S]*?where[\s\S]*?needs_investigation/i);
});

test('the order-context bundle stays a bundle, not columns on the ticket', () => {
  assert.match(sql, /resolved_context jsonb not null default '\{\}'::jsonb/i);
  assert.match(sql, /constraint tickets_resolved_context_object_check/i);
  assert.match(sql, /context_resolved_at timestamptz/i);
});

test('the archival and retention lifecycle is present and indexed', () => {
  for (const column of ['resolved_at', 'closed_at', 'archived_at', 'retention_delete_after', 'deleted_at']) {
    assert.match(sql, new RegExp(`${column} timestamptz`), column);
  }
  assert.match(sql, /create index tickets_retention_delete_after_idx/i);
});

test('tickets link to shops and customers with the established FK behaviour', () => {
  assert.match(sql, /shop_id uuid not null references public\.shops\(id\) on delete cascade/i);
  assert.match(sql, /customer_id uuid references public\.customers\(id\) on delete set null/i);
});

// --- messages ---------------------------------------------------------------

test('messages ingest idempotently and carry a direction', () => {
  assert.match(sql, /constraint ticket_messages_shop_message_unique unique \(shop_id, graph_message_id\)/i);
  assert.match(sql, /constraint ticket_messages_direction_check check \(\s*direction in \('inbound', 'outbound'\)\s*\)/i);
});

test('message bodies embed on the knowledge_chunks vector pattern', () => {
  const body = sql.split('create table public.ticket_messages')[1].split('\n);')[0];
  assert.match(body, /embedding vector\(1536\)/i);
  for (const column of ['embedding_model', 'embedding_dimensions', 'embedded_input_hash', 'embedded_at']) {
    assert.match(body, new RegExp(column), column);
  }
});

// --- the spam gate ----------------------------------------------------------

test('the blocklist restricts pattern_type and is unique per rule', () => {
  assert.match(sql, /constraint email_blocklist_pattern_type_check check \(pattern_type in \('email', 'domain'\)\)/i);
  assert.match(sql, /constraint email_blocklist_shop_pattern_unique unique \(shop_id, pattern_type, pattern\)/i);
  assert.match(sql, /constraint email_blocklist_hit_count_check check \(hit_count >= 0\)/i);
});

test('spam_audit constrains outcome, decider and label, and dedupes per message', () => {
  assert.match(sql, /constraint spam_audit_outcome_check check \(outcome in \('kept', 'blocked'\)\)/i);
  assert.match(sql, /constraint spam_audit_decided_by_check check \(decided_by in \('blocklist', 'llm'\)\)/i);
  assert.match(sql, /constraint spam_audit_label_check check \(label is null or label in \('keep', 'spam', 'irrelevant'\)\)/i);
  assert.match(sql, /constraint spam_audit_shop_message_unique unique \(shop_id, graph_message_id\)/i);
});

test('the dropped body has its own expiry, separate from the row', () => {
  // The decision is audit metadata and is kept for ever; the message text is
  // personal data and is not. One retention column would force one life on both.
  assert.match(sql, /body_text text/i);
  assert.match(sql, /body_captured_at timestamptz/i);
  assert.match(sql, /body_expires_at timestamptz/i);
  const body = sql.split('create table public.spam_audit')[1].split('\n);')[0];
  assert.doesNotMatch(body, /retention_delete_after/i);
});

test('the purge index is partial, so it only carries rows that still hold a body', () => {
  assert.match(
    sql,
    /create index spam_audit_body_expiry_idx\s+on public\.spam_audit \(shop_id, body_expires_at\)\s+where body_text is not null/i
  );
});

// --- the case file ----------------------------------------------------------

test('the verdict vocabulary matches the case-file module exactly', () => {
  // Written inline on the column rather than as a named constraint.
  const clause = columnCheck(sql.split('create table public.ticket_investigations')[1], 'verdict');
  assert.ok(clause, 'the verdict check is missing');
  assert.deepEqual(literalsIn(clause), [...VERDICTS].sort());
});

test('the four evidence sections are separate columns', () => {
  // Merging them is the measured failure: a doubt inside a list of facts reads
  // as a fact.
  for (const column of ['established', 'unverified', 'missing', 'do_not_claim']) {
    assert.match(sql, new RegExp(`${column} jsonb not null default '\\[\\]'::jsonb`, 'i'), column);
  }
});

test('one investigation per inbound message, and the memory seam is indexed', () => {
  assert.match(sql, /unique \(shop_id, trigger_message_id\)/i);
  assert.match(sql, /create index ticket_investigations_customer_idx/i);
});

test('a deleted customer nulls the link rather than deleting the case file', () => {
  const body = sql.split('create table public.ticket_investigations')[1].split('\n);')[0];
  assert.match(body, /customer_id uuid references public\.customers\(id\) on delete set null/i);
});

test('the findings trace is nullable, and the null is the point', () => {
  // NULL means the row predates the trace; `[]` means the run made no tool
  // calls. A `not null default '[]'` would state the second about every row
  // written before the column existed, and their tool `data` is gone, so no
  // backfill could ever correct it.
  const body = sql.split('create table public.ticket_investigations')[1].split('\n);')[0];
  assert.match(body, /findings_trace jsonb,/i);
  assert.doesNotMatch(body, /findings_trace jsonb not null/i);
  // Nullable, so the check has to allow null explicitly — a check evaluating to
  // null passes, and being right by accident is not the same as being right.
  assert.match(
    checkClause(sql, 'ticket_investigations_findings_trace_array_check'),
    /findings_trace is null or jsonb_typeof\(findings_trace\) = 'array'/i
  );
});

test('no column stores the reply intent or a confidence score', () => {
  // Both were measured to be worthless: the intent is derived from the verdict,
  // and the confidence answered `high` on 40 of 40 cases.
  const body = sql.split('create table public.ticket_investigations')[1].split('\n);')[0];
  assert.doesNotMatch(body, /reply_intent/i);
  assert.doesNotMatch(body, /confidence/i);
});

// --- forwarding -------------------------------------------------------------

test('the forwarding address book is one address per shop and category', () => {
  assert.match(sql, /unique \(shop_id, category\)/i);
  // A null address is the off switch: no separate enabled flag to disagree.
  const body = sql.split('create table public.category_forwarding')[1].split('\n);')[0];
  assert.doesNotMatch(body, /\benabled\b/i);
});

test('the routable categories match the shared taxonomy exactly', () => {
  // Written inline on the column rather than as a named constraint. The
  // knowledge-only shapes must never be routable: an article is not something
  // anyone emails support about.
  const clause = columnCheck(sql.split('create table public.category_forwarding')[1], 'category');
  assert.ok(clause, 'the forwarding category check is missing');
  assert.deepEqual(literalsIn(clause), [...TICKET_SUBJECTS].sort());
});

test('forwarding idempotency is keyed on the message, not the ticket', () => {
  // Per ticket, a candidate's follow-up would never reach the recipient.
  assert.match(sql, /ticket_message_id uuid not null unique references public\.ticket_messages\(id\) on delete cascade/i);
});

test('a forward records where it went, whether it worked, and how many tries', () => {
  assert.match(sql, /status text not null default 'sent' check \(status in \('sent', 'failed'\)\)/i);
  assert.match(sql, /attempts integer not null default 1/i);
  // Snapshot of the routing decision, so re-routing tomorrow does not rewrite
  // where mail went yesterday.
  const body = sql.split('create table public.ticket_forwards')[1].split('\n);')[0];
  assert.match(body, /category text not null/i);
  assert.match(body, /forward_email text not null/i);
});

// --- the review set ---------------------------------------------------------

test('the review set accepts exactly the labels the agent could produce', () => {
  const listed = literalsIn(clauseFor('categorisation_review_human_category_check'));
  assert.deepEqual(listed.sort(), [...TICKET_SUBJECTS].sort());
});

test('the review set is blind, minimises personal data and expires', () => {
  const body = sql.split('create table public.categorisation_review')[1].split('\n);')[0];
  // Agent columns exist but are filled only after a human has labelled.
  assert.match(body, /agent_category/i);
  // Sender reduced to a domain; no address at all.
  assert.match(body, /from_domain text/i);
  assert.doesNotMatch(body, /from_email/i);
  assert.match(body, /retention_delete_after timestamptz not null default \(now\(\) \+ interval '3 months'\)/i);
});

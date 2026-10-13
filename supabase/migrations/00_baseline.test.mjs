import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { ACTORS, MESSAGE_ACTORS, NEXT_ACTORS } from '../../agent/src/casework/actors.mjs';
import { DRAFT_PURPOSES, NOTICE_EVENTS } from '../../agent/src/casework/change-router.mjs';
import { INBOUND_EFFECTS, OUTBOUND_EFFECTS } from '../../agent/src/casework/effects.mjs';
import { MISSING_FIELDS, VERDICTS } from '../../agent/src/investigation/case-file.mjs';
import { NEED_KEYS } from '../../agent/src/investigation/evidence-rules.mjs';
import { USAGE_PASSES } from '../../agent/src/llm/usage-sink.mjs';
import { EDITABLE_AGENTS } from '../../scripts/lib/agent-models.mjs';
import { CASE_LINK_DECISIONS, CASE_LINK_METHODS, CASE_LINK_STATES } from '../../scripts/lib/case-record.mjs';
import { ADVISOR_T as ADVISORY_CORE_T, MAP_SECTIONS, SINGLE_SECTIONS } from '../../scripts/lib/advisory/advisory-repository.mjs';
import { CHANNELS, EVENT_TYPES } from '../../scripts/lib/advisory/events.mjs';
import { FORWARD_TIMINGS } from '../../scripts/lib/forwarding-destinations.mjs';
import { MAIL_JOB_KINDS, MAIL_JOB_STATES } from '../../scripts/lib/mail-job-record.mjs';
import { RETENTION_REASONS } from '../../scripts/lib/order-retention.mjs';
import { OUTBOUND_MODES, OUTBOUND_STATES } from '../../scripts/lib/outbound-record.mjs';
import { PARAMETER_KINDS } from '../../scripts/lib/parameters.mjs';
import { TONE_KEYS } from '../../scripts/lib/reply-tones.mjs';
import { SNOOZE_SOURCES, WAITING_FOR, WAKE_REASONS } from '../../scripts/lib/snooze-record.mjs';
import { BAND_METRICS } from '../../scripts/lib/social-bands.mjs';
import { AD_PUBLISHERS, AUDIENCE_DIMENSIONS, ORGANIC_KINDS, SOCIAL_KINDS, SOCIAL_PROVIDERS } from '../../scripts/lib/social-model.mjs';
import { KNOWLEDGE_CATEGORIES, REQUEST_KINDS, TICKET_SUBJECTS } from '../../scripts/lib/support-taxonomy.mjs';
import * as tables from '../../scripts/lib/tables.mjs';
import { OVERRIDE_FIELDS } from '../../scripts/lib/ticket-overrides.mjs';

/**
 * Invariants of the schema, read from the committed catalogue description.
 *
 * `00_baseline.catalog.json` is what `npm run db:check:baseline` proves a fresh
 * build of `00_baseline.sql` equals, and what the generator read from production.
 * So these assertions are about the schema production actually has — and they
 * replace the per-file tests of the archived chain, whose cross-checks against
 * application code are kept here (2026-10-13).
 */
const CATALOG = JSON.parse(readFileSync(new URL('./00_baseline.catalog.json', import.meta.url), 'utf8'));
const TABLES = CATALOG.tables;
const VIEWS = CATALOG.views;

/** constraint name -> its definition, across every table */
const CONSTRAINTS = new Map(
  Object.values(TABLES).flatMap((t) => t.constraints.map((c) => [c.slice(0, c.indexOf(':')), c.slice(c.indexOf(':') + 2)]))
);
/** The quoted literals of a constraint, sorted (`'a'::text` -> a). */
const literalsOf = (name) => {
  const def = CONSTRAINTS.get(name);
  assert.ok(def, `no constraint named ${name}`);
  return [...new Set([...def.matchAll(/'([^']+)'/g)].map((m) => m[1]))].sort();
};
const sorted = (values) => [...new Set(values)].sort();

// THE APPLICATION'S LISTS, ONE PER CONSTRAINT THAT MIRRORS ONE. A check
// constraint and the module it mirrors drifting apart means writes the code
// believes valid are refused at runtime (or values the code no longer knows are
// still accepted). Each pair was a cross-check in the archived per-file tests.
const MIRRORS = [
  ['tickets_category_check', TICKET_SUBJECTS],
  ['tickets_secondary_category_check', TICKET_SUBJECTS],
  ['tickets_request_kind_check', REQUEST_KINDS],
  ['tickets_secondary_request_kind_check', REQUEST_KINDS],
  ['support_exemplars_category_check', TICKET_SUBJECTS],
  ['support_exemplars_request_kind_check', REQUEST_KINDS],
  ['forwarding_destinations_request_kinds_check', REQUEST_KINDS],
  ['knowledge_documents_category_check', KNOWLEDGE_CATEGORIES],
  ['support_answers_ask_check', Object.keys(MISSING_FIELDS)],
  ['support_answers_tones_check', TONE_KEYS],
  ['support_answers_notify_on_check', NOTICE_EVENTS],
  ['ticket_drafts_purpose_check', DRAFT_PURPOSES],
  ['llm_usage_pass_check', USAGE_PASSES],
  ['support_parameters_kind_check', PARAMETER_KINDS],
  ['orders_retention_rule_check', RETENTION_REASONS],
  ['ticket_messages_actor_check', MESSAGE_ACTORS],
  ['ticket_case_state_actor_check', ACTORS],
  ['case_current_last_actor_check', ACTORS],
  ['case_current_next_actor_check', NEXT_ACTORS],
  ['ticket_case_state_effect_check', [...Object.keys(INBOUND_EFFECTS), ...Object.keys(OUTBOUND_EFFECTS)]],
  ['mail_jobs_kind_check', MAIL_JOB_KINDS],
  ['mail_jobs_state_check', MAIL_JOB_STATES],
  ['outbound_actions_state_check', OUTBOUND_STATES],
  ['outbound_actions_mode_check', OUTBOUND_MODES],
  ['ticket_overrides_field_check', OVERRIDE_FIELDS],
  ['forwarding_destinations_timing_check', FORWARD_TIMINGS],
  ['agent_models_agent_check', EDITABLE_AGENTS],
  ['ticket_snoozes_source_check', SNOOZE_SOURCES],
  ['ticket_snoozes_waiting_for_check', WAITING_FOR],
  ['ticket_snoozes_wake_reason_check', WAKE_REASONS],
  ['case_links_method_check', CASE_LINK_METHODS],
  ['case_links_decision_check', CASE_LINK_DECISIONS],
  ['tickets_case_link_state_check', CASE_LINK_STATES],
  ['social_connections_provider_check', SOCIAL_PROVIDERS],
  ['social_accounts_provider_check', SOCIAL_PROVIDERS],
  ['social_accounts_kind_check', SOCIAL_KINDS],
  ['social_metric_bands_kind_check', ORGANIC_KINDS],
  ['social_metric_bands_metric_check', BAND_METRICS],
  ['ad_days_publisher_check', AD_PUBLISHERS],
  ['social_audience_dimension_check', AUDIENCE_DIMENSIONS],
  ['advisor_mappings_kind_check', [...MAP_SECTIONS, ...SINGLE_SECTIONS]],
  ['advisory_events_channel_check', CHANNELS],
  ['advisory_events_type_check', EVENT_TYPES]
];

for (const [name, values] of MIRRORS) {
  test(`${name} admits exactly what the application uses`, () => {
    assert.deepEqual(literalsOf(name), sorted(values));
  });
}

test('the needs a rule may require are the evidence vocabulary', () => {
  // Superset, not equality: retired needs stay admissible so old rows remain valid.
  const admitted = new Set(literalsOf('support_exemplars_requirement_needs_check'));
  for (const need of NEED_KEYS) assert.ok(admitted.has(need), `need ${need} is not admitted`);
});

test('a ticket investigation verdict is one the case file can produce', () => {
  const verdicts = [...CONSTRAINTS.entries()].filter(([name]) => /^ticket_investigations_.*verdict.*_check$/.test(name));
  assert.ok(verdicts.length > 0, 'no verdict constraint on ticket_investigations');
  for (const [name] of verdicts) assert.deepEqual(literalsOf(name), sorted(VERDICTS), name);
});

test('every name the code uses for a table, view or function exists', () => {
  // scripts/lib/tables.mjs is what the packages import instead of quoting names;
  // a rename that misses it fails here instead of in PostgREST at runtime.
  const relations = new Set([...Object.keys(TABLES), ...Object.keys(VIEWS)].map((n) => n.replace(/^public\./, '')));
  const functions = new Set(Object.keys(CATALOG.functions).map((f) => f.replace(/^public\./, '').replace(/\(.*$/, '')));
  for (const [exportName, map] of Object.entries(tables)) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    const isRpc = /RPC$/.test(exportName);
    const isRelation = exportName === 'V' || /(^|_)T$/.test(exportName);
    if (!isRpc && !isRelation) continue;
    for (const [key, name] of Object.entries(map)) {
      if (typeof name !== 'string') continue;
      assert.ok((isRpc ? functions : relations).has(name), `${exportName}.${key} names ${name}, which does not exist`);
    }
  }
});

test('every column a shared projection reads exists on its relation', () => {
  const columnsOf = (relation) => {
    const r = TABLES[`public.${relation}`] ?? VIEWS[`public.${relation}`];
    assert.ok(r, `${relation} does not exist`);
    return new Set(r.columns.map((c) => c.split(' ')[0]));
  };
  for (const [name, projection] of Object.entries(tables.COLUMNS)) {
    const source = tables.PROJECTION_SOURCE[name];
    assert.ok(source, `COLUMNS.${name} has no entry in PROJECTION_SOURCE`);
    const own = projection.replace(/\w+\([^)]*\)/g, '').split(',').filter(Boolean).map((e) => e.trim().replace(/^\w+:/, '').split(/->>?/)[0]);
    const available = columnsOf(source);
    for (const column of own) assert.ok(available.has(column), `COLUMNS.${name} reads ${source}.${column}, which does not exist`);
    for (const [, relation, columns] of projection.matchAll(/(\w+)\(([^)]*)\)/g)) {
      const embedded = columnsOf(relation);
      for (const column of columns.split(',').filter(Boolean)) assert.ok(embedded.has(column.trim()), `COLUMNS.${name} embeds ${relation}.${column}`);
    }
  }
});

test('every table has row-level security on: no policies, so only the service role reads', () => {
  for (const [name, t] of Object.entries(TABLES)) assert.equal(t.rls, true, `${name} has RLS off`);
});

test('every public view reads with the caller\'s rights and is closed to anon and authenticated', () => {
  // An owner-rights view over tickets would be the one way an anon key reads the
  // whole support mailbox. (The chat schema is the deliberate exception: owner
  // rights, reachable by mgmt_chat_ro only.)
  for (const [name, v] of Object.entries(VIEWS)) {
    if (!name.startsWith('public.')) continue;
    assert.ok(v.options.includes('security_invoker=true'), `${name} is not security_invoker`);
    assert.equal(v.acl.anon, undefined, `${name} is granted to anon`);
    assert.equal(v.acl.authenticated, undefined, `${name} is granted to authenticated`);
  }
});

test('the chat views are readable by the chat role and by nobody else outside the platform', () => {
  for (const [name, v] of Object.entries(VIEWS)) {
    if (!name.startsWith('chat.')) continue;
    assert.ok((v.acl.mgmt_chat_ro || '').includes('r'), `${name} is not readable by mgmt_chat_ro`);
    assert.equal(v.acl.anon, undefined, `${name} is granted to anon`);
    assert.equal(v.acl.authenticated, undefined, `${name} is granted to authenticated`);
  }
  assert.deepEqual(Object.keys(CATALOG.chatSchemaAcl), ['mgmt_chat_ro']);
  assert.ok(CATALOG.chatRole.config.includes('default_transaction_read_only=on'));
});

test('every table holding a vector carries the determinism quadruple and the same dimension check', () => {
  for (const [name, t] of Object.entries(TABLES)) {
    const columns = t.columns.map((c) => c.split(' ')[0]);
    if (!columns.includes('embedding')) continue;
    for (const column of tables.VECTOR_COLUMNS) assert.ok(columns.includes(column), `${name} holds an embedding but no ${column}`);
    const short = name.replace(/^public\./, '');
    assert.equal(
      CONSTRAINTS.get(`${short}_embedding_dimensions_check`),
      'CHECK (((embedding_dimensions IS NULL) OR (embedding_dimensions = 1536)))',
      `${name} constrains embedding_dimensions differently`
    );
  }
});

// Their services write updated_at themselves on every upsert (social-audience-
// manual-, social-bands-, social-post-manual-service), so nothing is stale; they
// came in after the archived invariant stopped being checked. Named, so a NEW
// table without the trigger still fails.
const APP_MAINTAINED_UPDATED_AT = ['public.social_audience_manual', 'public.social_metric_bands', 'public.social_post_manual_metrics'];

test('every table with updated_at keeps it current with the shared trigger', () => {
  for (const [name, t] of Object.entries(TABLES)) {
    if (!t.columns.some((c) => c.startsWith('updated_at ')) || APP_MAINTAINED_UPDATED_AT.includes(name)) continue;
    const short = name.replace(/^\w+\./, '');
    assert.ok(
      CATALOG.triggers.some((d) => d.includes(` ON ${name} `) && d.includes('set_updated_at()')),
      `${short} has updated_at but no set_updated_at trigger`
    );
  }
});

test('the advisory core copy of its table names matches tables.mjs', () => {
  // advisory-repository.mjs imports nothing outside its directory, so it keeps a
  // copy; this is what keeps the copy honest.
  assert.deepEqual(ADVISORY_CORE_T, tables.ADVISOR_T);
});

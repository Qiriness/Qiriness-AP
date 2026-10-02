import assert from 'node:assert/strict';
import test from 'node:test';

import { codeOnly, read } from './_shared.test.mjs';

const SQL = read('62_case_lead');
const SUPPORT = read('04_support');

const viewOf = (sql, name) =>
  sql.match(new RegExp(`create (?:or replace )?view public\\.${name}\\n[\\s\\S]*?;\\n`))?.[0].replace(/^create or replace view/, 'create view');

test('case_facts is copied from 04, byte for byte', () => {
  assert.ok(viewOf(SUPPORT, 'case_facts'));
  assert.equal(viewOf(SQL, 'case_facts'), viewOf(SUPPORT, 'case_facts'));
});

test('without a reply thread, the lead is the latest LIVE thread before the latest of all', () => {
  const view = viewOf(SUPPORT, 'case_facts');
  assert.match(view, /case when a\.has_reply_thread then k\.reply_thread_id else a\.fallback_lead_id end as lead_ticket_id/);
  assert.match(view, /array_agg\(t\.id order by \(t\.status not in \('resolved', 'closed'\)\) desc, t\.last_message_at desc nulls last\)\)\[1\] as fallback_lead_id/);
});

test('it only replaces the view: idempotent, nothing written', () => {
  const code = codeOnly(SQL);
  assert.match(code, /^create or replace view public\.case_facts$/m);
  assert.doesNotMatch(code, /^\s*(insert|update|delete|alter|drop)\b/im);
});

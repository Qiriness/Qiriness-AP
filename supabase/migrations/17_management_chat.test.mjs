import assert from 'node:assert/strict';
import test from 'node:test';

import { CHAT_T } from '../../scripts/lib/tables.mjs';
import { ALL, codeOnly, read, viewsIn } from './_shared.test.mjs';

const SQL = read('17_management_chat');
const CODE = codeOnly(SQL);

const chatViews = () => [...CODE.matchAll(/create (?:or replace )?view chat\.(\w+)/g)].map((m) => m[1]);

/** One view's statement, up to its terminating semicolon. */
function viewBody(name) {
  const start = CODE.search(new RegExp(`create (?:or replace )?view chat\\.${name} as`));
  return CODE.slice(start, CODE.indexOf(';', start));
}

test('no chat view reads a baseline view, because those are security_invoker', () => {
  // An invoker view nested inside an owner-rights view checks its tables as the
  // querying role, which reads nothing: found on the live database, 2026-09-14,
  // when three chat views built on 04/06 views answered "permission denied".
  const baselineViews = new Set(viewsIn(ALL));
  for (const view of chatViews()) {
    for (const [, relation] of viewBody(view).matchAll(/\b(?:from|join) public\.(\w+)/g)) {
      assert.ok(!baselineViews.has(relation), `chat.${view} reads public.${relation}, a security_invoker view`);
    }
  }
});

test('fulfilment timing is computed the way 06 computes it', () => {
  const lateral = (sql) => {
    const start = sql.indexOf('left join lateral (\n    select\n      min(nullif(');
    return sql.slice(start, sql.indexOf(') f on true', start));
  };
  const ours = lateral(viewBody('fulfilment_timing'));
  assert.ok(ours.length > 100);
  assert.equal(ours, lateral(codeOnly(read('06_analytics'))));
  assert.match(viewBody('fulfilment_timing'), /public\.normalise_carrier\(f\.carrier_raw\) as carrier/);
  // The key the order mapper writes (shopify-order-mapper.mjs), not 06's `countryCode`.
  assert.match(viewBody('fulfilment_timing'), /shipping_destination ->> 'country_code'/);
});

test('the role can log in, bypasses nothing, and is read-only with a timeout', () => {
  assert.match(CODE, /create role mgmt_chat_ro login [^;]*nobypassrls/);
  assert.match(CODE, /if not exists \(select 1 from pg_roles where rolname = 'mgmt_chat_ro'\)/);
  assert.match(CODE, /alter role mgmt_chat_ro set default_transaction_read_only = on;/);
  assert.match(CODE, /alter role mgmt_chat_ro set statement_timeout = '10s';/);
  assert.match(CODE, /alter role mgmt_chat_ro set search_path = chat;/);
});

test('no password is ever written into the file', () => {
  assert.doesNotMatch(CODE, /password/i);
});

test('the role is granted the chat schema and one function, and nothing else', () => {
  const grants = [...CODE.matchAll(/grant ([^;]+) to mgmt_chat_ro;/g)].map((m) => m[1].replace(/\s+/g, ' '));
  assert.deepEqual(grants.sort(), [
    'execute on function public.normalise_carrier(text)',
    'select on all tables in schema chat',
    'usage on schema chat'
  ]);
  // Nothing in public may be granted beyond that pure function.
  // `\bon` so the "on" inside "function public" is not read as `on public`.
  assert.doesNotMatch(CODE, /grant [^;]*\bon (table |all tables in schema |schema )?public\b/);
});

test('the chat schema and its views are closed to everyone else', () => {
  assert.match(CODE, /revoke all on schema chat from public, anon, authenticated;/);
  assert.match(CODE, /revoke all on all tables in schema chat from public, anon, authenticated;/);
  // The revoke must come after the views exist, or it revokes from nothing.
  const lastView = CODE.lastIndexOf('create or replace view chat.');
  assert.ok(CODE.indexOf('revoke all on all tables in schema chat') > lastView);
  assert.ok(CODE.indexOf('grant select on all tables in schema chat') > lastView);
});

test('every chat view is documented, because the comments are what the model reads', () => {
  const views = chatViews();
  assert.ok(views.length >= 10);
  for (const view of views) {
    assert.match(CODE, new RegExp(`comment on view chat\\.${view} is`), `chat.${view} has no comment`);
  }
});

test('the chat views are owner-rights, as the one documented exception', () => {
  // Invoker views would read zero rows as a role that does not bypass RLS.
  for (const view of chatViews()) {
    assert.doesNotMatch(viewBody(view), /security_invoker/, `chat.${view} sets security_invoker`);
  }
});

test('no chat view selects personal data', () => {
  const personal = [
    'email',
    'phone',
    'first_name',
    'last_name',
    'display_name',
    'requester_name',
    'requester_email_hash',
    'customer_email_hash',
    'customer_email_masked',
    'customer_phone_hash',
    'resolved_context',
    'candidate_order',
    'reaction_report',
    'raw_shopify_payload',
    'subject',
    'body_text',
    'from_email',
    'default_address_city',
    'codes ->>'
  ];
  for (const view of chatViews()) {
    // The one permitted mention of a body: whether a reviewer rewrote it.
    const body = viewBody(view).replace('d.approved_body_text is not null', '');
    for (const column of personal) {
      assert.doesNotMatch(body, new RegExp(`\\b${column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`), `chat.${view} selects ${column}`);
    }
    assert.doesNotMatch(body, /'city'|'address/, `chat.${view} reaches a street-level destination`);
  }
});

test('every view item carries an explicit alias', () => {
  for (const view of chatViews()) {
    const body = viewBody(view);
    const list = body.slice(body.indexOf('select') + 6, body.search(/\n\s*from public\./));
    let depth = 0;
    let item = '';
    const items = [];
    for (const char of list) {
      if (char === '(') depth += 1;
      if (char === ')') depth -= 1;
      if (char === ',' && depth === 0) {
        items.push(item);
        item = '';
      } else item += char;
    }
    items.push(item);
    for (const entry of items) assert.match(entry.trim(), /\bas \w+$/, `chat.${view}: ${entry.trim()}`);
  }
});

test('the log tables are the ones the contract names, each with RLS and a comment', () => {
  const created = [...CODE.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(created.sort(), Object.values(CHAT_T).sort());
  for (const table of created) {
    assert.match(CODE, new RegExp(`alter table public\\.${table} enable row level security;`));
    assert.match(CODE, new RegExp(`revoke all on public\\.${table} from anon, authenticated;`));
    assert.match(CODE, new RegExp(`comment on table public\\.${table} is`));
  }
});

test('a turn status is one the service writes', () => {
  assert.match(CODE, /status in \('running', 'ok', 'step_limit', 'empty', 'error'\)/);
});

test('it writes no data', () => {
  assert.doesNotMatch(CODE, /^\s*(insert|update|delete)\s/im);
});

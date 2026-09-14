import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_ROWS, checkSql, wrapForExecution } from './chat-sql-guard.mjs';

const accepted = (sql) => {
  const result = checkSql(sql);
  assert.equal(result.ok, true, `refused: ${sql} -> ${result.error}`);
  return result.sql;
};
const refused = (sql, pattern) => {
  const result = checkSql(sql);
  assert.equal(result.ok, false, `accepted: ${sql}`);
  if (pattern) assert.match(result.error, pattern);
};

test('plain SELECT and WITH queries are accepted', () => {
  accepted('select count(*) from chat.orders');
  accepted('SELECT channel, sum(total_price) FROM chat.orders GROUP BY 1');
  accepted('with m as (select 1 as x) select * from m');
  accepted('(select 1) union all (select 2)');
});

test('one trailing semicolon and comments are removed, not refused', () => {
  assert.equal(accepted('select 1;'), 'select 1');
  assert.equal(accepted('select 1; -- the total\n'), 'select 1');
  assert.doesNotMatch(accepted('select /* note */ 1 -- trailing'), /note|trailing/);
});

test('a forbidden word inside a string literal is not a statement', () => {
  accepted("select count(*) from chat.tickets where category = 'account_deletion' or request_kind = 'delete my data'");
  accepted("select 'it''s an update' as label");
  accepted("select E'don\\'t drop' as label");
});

test('a forbidden word as part of a longer name is not refused', () => {
  accepted('select max(shopify_updated_at), count(*) filter (where created_at is not null) from chat.orders');
});

test('anything that writes or changes the schema is refused', () => {
  for (const sql of [
    "insert into chat.orders values (1)",
    'update chat.orders set total_price = 0',
    'delete from chat.orders',
    'drop view chat.orders',
    'truncate chat.orders',
    'alter role mgmt_chat_ro set statement_timeout = 0',
    'grant select on chat.orders to anon',
    'with gone as (delete from chat.orders returning *) select * from gone',
    'select * into scratch from chat.orders',
    'select * from chat.orders for update',
    'set statement_timeout = 0',
    'copy chat.orders to stdout'
  ]) {
    refused(sql);
  }
});

test('only SELECT or WITH may start a query', () => {
  refused('explain select 1', /Only SELECT or WITH/);
  refused('values (1)', /Only SELECT or WITH/);
  refused('show search_path');
});

test('a second statement is refused, however it is hidden', () => {
  refused('select 1; select 2', /one statement/);
  refused('select 1; drop view chat.orders');
  refused("select 1 /* ; */ ; select 2", /one statement/);
});

test('settings, text-as-query functions and the catalogues are out of reach', () => {
  refused("select set_config('statement_timeout', '0', true)");
  refused("select query_to_xml('delete from chat.orders', true, true, '')");
  refused('select pg_sleep(30)', /catalogues/);
  refused('select * from pg_catalog.pg_roles', /catalogues/);
  refused('select table_name from information_schema.tables', /catalogues/);
});

test('only the chat schema may be named', () => {
  refused('select * from public.tickets', /chat schema/);
  refused('select email from auth.users', /chat schema/);
  refused('select * from "public".customers', /chat schema/);
  refused('select * from vault.secrets', /chat schema/);
});

test('input that cannot be read safely is refused', () => {
  refused('', /empty/);
  refused('   ', /empty/);
  refused(null, /empty/);
  refused("select 'unterminated", /unterminated string/);
  refused('select 1 /* open', /unterminated/);
  refused('select $$drop$$', /Dollar/);
  refused(`select 1 ${'-- x\n'.repeat(6000)}`, /longer than/);
});

test('the executed statement is capped one row past the limit, and survives a trailing comment', () => {
  const wrapped = wrapForExecution('select 1 -- note');
  assert.match(wrapped, new RegExp(`limit ${MAX_ROWS + 1}$`));
  // The comment is on its own line, so the closing parenthesis still counts.
  assert.match(wrapped, /-- note\n\) as chat_result/);
  assert.equal(MAX_ROWS, 1000);
});

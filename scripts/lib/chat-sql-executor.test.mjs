import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ChatDatabaseUnavailableError,
  createSqlExecutor,
  describeError,
  renderSchema
} from './chat-sql-executor.mjs';

/** A pool whose one client records every statement and plays back a result or an error. */
function fakePool({ rows = [], fields = ['n'], error = null, connectError = null } = {}) {
  const statements = [];
  let released = 0;
  const client = {
    async query(query) {
      const text = typeof query === 'string' ? query : query.text;
      statements.push({ text, rowMode: query.rowMode });
      if (typeof query !== 'string') {
        if (error) throw error;
        return { rows, fields: fields.map((name) => ({ name })) };
      }
      return {};
    },
    release() {
      released += 1;
    }
  };
  return {
    statements,
    released: () => released,
    pool: {
      async connect() {
        if (connectError) throw connectError;
        return client;
      }
    }
  };
}

test('a refused query never reaches the database', async () => {
  const fake = fakePool();
  const execute = createSqlExecutor({ pool: fake.pool });
  const result = await execute('delete from chat.orders');
  assert.equal(result.ok, false);
  assert.equal(result.refused, true);
  assert.equal(fake.statements.length, 0);
});

test('a query runs read-only, with a timeout, wrapped, as arrays, and is always rolled back', async () => {
  const fake = fakePool({ rows: [['6008']] });
  let clock = 1000;
  const execute = createSqlExecutor({ pool: fake.pool, now: () => (clock += 25) });
  const result = await execute('select count(*) as n from chat.orders;');

  assert.deepEqual(
    fake.statements.map((s) => s.text.split('\n')[0]),
    ['begin transaction read only', 'set local statement_timeout = 10000', 'select * from (', 'rollback']
  );
  assert.match(fake.statements[2].text, /select count\(\*\) as n from chat\.orders\n\) as chat_result limit 1001$/);
  assert.equal(fake.statements[2].rowMode, 'array');
  assert.deepEqual(result, {
    ok: true,
    columns: ['n'],
    rows: [['6008']],
    rowCount: 1,
    truncated: false,
    durationMs: 25,
    error: null
  });
  assert.equal(fake.released(), 1);
});

test('one row past the cap marks the result truncated and is dropped', async () => {
  const fake = fakePool({ rows: Array.from({ length: 6 }, (_, i) => [i]) });
  const execute = createSqlExecutor({ pool: fake.pool, maxRows: 5 });
  const result = await execute('select i from chat.orders');
  assert.equal(result.truncated, true);
  assert.equal(result.rowCount, 5);
  assert.match(fake.statements[2].text, /limit 6$/);
});

test('a failing query is reported, rolled back and released', async () => {
  const fake = fakePool({ error: Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }) });
  const execute = createSqlExecutor({ pool: fake.pool });
  const result = await execute('select * from chat.order_lines');
  assert.equal(result.ok, false);
  assert.match(result.error, /stopped after 10 s/);
  assert.equal(fake.statements.at(-1).text, 'rollback');
  assert.equal(fake.released(), 1);
});

test('no connection is an error for the turn, not a query result for the model', async () => {
  const fake = fakePool({ connectError: new Error('password authentication failed') });
  const execute = createSqlExecutor({ pool: fake.pool });
  await assert.rejects(() => execute('select 1'), ChatDatabaseUnavailableError);
});

test('errors the model would misread are reworded', () => {
  assert.match(describeError({ code: '42501', message: 'permission denied for table tickets' }), /only the views in the chat schema/);
  assert.match(describeError({ code: '25006' }), /read-only/);
  assert.equal(describeError({ code: '42703', message: 'column "revenue" does not exist' }), 'column "revenue" does not exist');
});

test('the schema renders one block per view, with the comments beside what they describe', () => {
  const text = renderSchema([
    { view_name: 'orders', view_comment: 'One row per order.', column_name: 'order_id', data_type: 'uuid', column_comment: null },
    { view_name: 'orders', view_comment: 'One row per order.', column_name: 'total_price', data_type: 'numeric(12,2)', column_comment: 'After discounts.' },
    { view_name: 'shop', view_comment: null, column_name: 'iana_timezone', data_type: 'text', column_comment: null }
  ]);
  assert.equal(
    text,
    'chat.orders — One row per order.\n  order_id uuid\n  total_price numeric(12,2) — After discounts.\n\nchat.shop\n  iana_timezone text'
  );
  assert.equal(renderSchema([]), '');
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_ROWS_TO_MODEL,
  STEP_LIMIT_ANSWER,
  buildHistory,
  resultForModel,
  runChatTurn
} from './chat-agent-loop.mjs';

/** A client that plays back one scripted turn per call and records what it was sent. */
function scriptedClient(turns) {
  const calls = [];
  return {
    calls,
    async completeWithTools(request) {
      calls.push({ ...request, messages: [...request.messages] });
      const turn = turns[calls.length - 1];
      if (!turn) throw new Error('script exhausted');
      return {
        content: turn.content ?? null,
        toolCalls: turn.toolCalls ?? [],
        message: { content: turn.content ?? null, tool_calls: (turn.toolCalls ?? []).map((c) => ({ id: c.id })) },
        usage: turn.usage ?? { prompt_tokens: 100, completion_tokens: 10 }
      };
    }
  };
}

const sqlCall = (sql, id = 'call_1') => ({ id, name: 'execute_sql', args: { sql }, argsError: null });
const okResult = (rows, columns = ['n']) => ({
  ok: true,
  columns,
  rows,
  rowCount: rows.length,
  truncated: false,
  durationMs: 12
});

test('a question needing no query is answered in one step', async () => {
  const client = scriptedClient([{ content: 'That is not something the database holds.' }]);
  const result = await runChatTurn({ client, model: 'm', system: 's', question: 'q', executeSql: async () => okResult([]) });
  assert.equal(result.status, 'ok');
  assert.equal(result.steps, 1);
  assert.deepEqual(result.queries, []);
});

test('a query runs, its result goes back to the model, and the answer comes after', async () => {
  const client = scriptedClient([
    { toolCalls: [sqlCall('select count(*) as n from chat.orders')] },
    { content: '6,008 orders.', usage: { prompt_tokens: 300, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 100 } } }
  ]);
  const events = [];
  const result = await runChatTurn({
    client,
    model: 'm',
    system: 's',
    question: 'How many orders?',
    executeSql: async () => okResult([['6008']]),
    onEvent: (event) => events.push(event.type)
  });

  assert.equal(result.answer, '6,008 orders.');
  assert.equal(result.steps, 2);
  assert.equal(result.queries.length, 1);
  assert.equal(result.queries[0].sql, 'select count(*) as n from chat.orders');
  assert.deepEqual(result.usage, { inputTokens: 400, cachedInputTokens: 100, outputTokens: 30, calls: 2 });

  const second = client.calls[1].messages;
  assert.equal(second.at(-2).role, 'assistant');
  assert.equal(second.at(-1).role, 'tool');
  assert.equal(second.at(-1).tool_call_id, 'call_1');
  assert.match(second.at(-1).content, /"row_count":1/);
  assert.deepEqual(events, ['thinking', 'query_started', 'query_finished', 'thinking']);
});

test('a refused or failed query is handed back to the model, which can correct it', async () => {
  const client = scriptedClient([
    { toolCalls: [sqlCall('select * from public.tickets')] },
    { toolCalls: [sqlCall('select count(*) from chat.tickets', 'call_2')] },
    { content: 'Answer.' }
  ]);
  const executeSql = async (sql) =>
    sql.includes('public.') ? { ok: false, error: 'Only views in the chat schema can be queried.' } : okResult([['172']]);
  const result = await runChatTurn({ client, model: 'm', system: 's', question: 'q', executeSql });

  assert.equal(result.status, 'ok');
  assert.equal(result.queries[0].ok, false);
  assert.match(result.queries[0].error, /chat schema/);
  assert.match(client.calls[1].messages.at(-1).content, /^Error: Only views in the chat schema/);
});

test('an executeSql that throws is recorded as a failed query, not a crashed turn', async () => {
  const client = scriptedClient([{ toolCalls: [sqlCall('select 1')] }, { content: 'Could not tell.' }]);
  const result = await runChatTurn({
    client,
    model: 'm',
    system: 's',
    question: 'q',
    executeSql: async () => {
      throw new Error('connection reset');
    }
  });
  assert.equal(result.queries[0].error, 'connection reset');
  assert.equal(result.status, 'ok');
});

test('malformed arguments and unknown tools are explained, and nothing is run', async () => {
  let ran = 0;
  const client = scriptedClient([
    {
      toolCalls: [
        { id: 'a', name: 'execute_sql', args: null, argsError: 'Unexpected end of JSON input' },
        { id: 'b', name: 'drop_table', args: {}, argsError: null }
      ]
    },
    { content: 'Done.' }
  ]);
  await runChatTurn({ client, model: 'm', system: 's', question: 'q', executeSql: async () => (ran += 1, okResult([])) });

  const tools = client.calls[1].messages.filter((message) => message.role === 'tool');
  assert.equal(ran, 0);
  assert.match(tools[0].content, /not JSON with an "sql" string \(Unexpected end/);
  assert.match(tools[1].content, /no tool called drop_table/);
});

test('the last step forbids tools and says so; a model that still asks gets the step-limit answer', async () => {
  const turns = Array.from({ length: 3 }, (_, i) => ({ toolCalls: [sqlCall('select 1', `c${i}`)] }));
  const client = scriptedClient(turns);
  const result = await runChatTurn({
    client,
    model: 'm',
    system: 's',
    question: 'q',
    maxSteps: 3,
    executeSql: async () => okResult([['1']])
  });

  assert.equal(client.calls[0].toolChoice, 'auto');
  assert.equal(client.calls[2].toolChoice, 'none');
  assert.match(client.calls[2].messages.at(-1).content, /last step/);
  assert.equal(result.status, 'step_limit');
  assert.equal(result.answer, STEP_LIMIT_ANSWER);
  // The tool calls asked for on the last step were not run.
  assert.equal(result.queries.length, 2);
});

test('the model sees at most 200 rows, and is told when it is not seeing all of them', () => {
  const rows = Array.from({ length: 500 }, (_, i) => [i]);
  const text = resultForModel({ ok: true, columns: ['i'], rows, rowCount: 500, truncated: false });
  assert.equal(text.split('\n').length, 1 + MAX_ROWS_TO_MODEL + 1);
  assert.match(text, /only the first 200 of 500 rows/);

  const cut = resultForModel({ ok: true, columns: ['i'], rows: rows.slice(0, 10), rowCount: 1000, truncated: true });
  assert.match(cut, /cut off at 1000/);
  assert.match(cut, /"cut_off_at_limit":true/);
});

test('long cells and objects are clipped, and dates are ISO strings', () => {
  const text = resultForModel({
    ok: true,
    columns: ['a', 'b', 'c'],
    rows: [['x'.repeat(1000), { k: 1 }, new Date('2026-09-01T00:00:00Z')]],
    rowCount: 1,
    truncated: false
  });
  const row = JSON.parse(text.split('\n')[1]);
  assert.equal(row[0].length, 301);
  assert.equal(row[1], '{"k":1}');
  assert.equal(row[2], '2026-09-01T00:00:00.000Z');
});

test('history replays questions, answers and the SQL behind them, never the rows', () => {
  const turns = Array.from({ length: 12 }, (_, i) => ({
    question: `q${i}`,
    answer: `a${i}`,
    queries: [{ sql: `select ${i}`, rowCount: 3, rows: [[1], [2], [3]] }]
  }));
  const history = buildHistory(turns);

  assert.equal(history.length, 20);
  assert.equal(history[0].content, 'q2');
  assert.match(history[1].content, /^a2\n\n\[Internal note/);
  assert.match(history[1].content, /\(3 rows\) select 2/);
  assert.doesNotMatch(JSON.stringify(history), /\[\[1\]/);
  assert.deepEqual(buildHistory([{ question: 'q', answer: 'a' }])[1], { role: 'assistant', content: 'a' });
});

/**
 * The management chat's agent loop: a question in, a management-level answer
 * out, and every SQL query the model ran on the way.
 *
 * SHAPED LIKE THE INVESTIGATION'S LOOP. The transport (`completeWithTools` in
 * agent/src/llm/openai-client.mjs) does one round trip; the step budget, the
 * tool dispatch and when to stop live here, where a scripted client drives them
 * without a network.
 *
 * ONE TOOL, `execute_sql`. What may run is decided by chat-sql-guard.mjs and,
 * underneath it, by the database role. This module decides only what the MODEL
 * is shown of a result: a capped, clipped rendering, because the full thousand
 * rows go to the screen and the log and would otherwise go into the prompt of
 * every later step.
 *
 * Pure apart from what is injected: `client` and `executeSql`.
 */

import { MAX_ROWS } from './chat-sql-guard.mjs';

/** Model calls per question, including the one that writes the answer. */
export const MAX_STEPS = 8;

export const MAX_ROWS_TO_MODEL = 200;
export const MAX_RESULT_CHARS = 16_000;
export const MAX_CELL_CHARS = 300;

/** Earlier question/answer pairs replayed into a follow-up. */
export const MAX_HISTORY_TURNS = 10;

export const EXECUTE_SQL_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'execute_sql',
    description:
      `Run ONE read-only SELECT or WITH query against the views in the chat schema. ` +
      `Returns the columns and rows (at most ${MAX_ROWS}), or an error to correct. ` +
      `Aggregate in SQL; do not fetch rows to count them.`,
    parameters: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'A single SELECT or WITH statement over chat.* views.' }
      },
      required: ['sql'],
      additionalProperties: false
    },
    strict: true
  }
});

export const STEP_LIMIT_ANSWER =
  'I ran out of steps before reaching an answer I can stand behind, so I am not giving a figure. ' +
  'Try a narrower question: one metric, one period.';

export const EMPTY_ANSWER = 'The model returned no answer, so there is nothing to report.';

const FINAL_STEP_NOTE =
  'This is the last step: no more queries can run. Answer now, using only figures that appear in the ' +
  'query results above. If they do not settle the question, say what is missing instead of estimating.';

/**
 * Runs one question to an answer.
 *
 * @param {object} options
 * @param {{completeWithTools: Function}} options.client
 * @param {string} options.model
 * @param {string} options.system
 * @param {Array<object>} [options.history]  from `buildHistory`
 * @param {string} options.question
 * @param {(sql: string) => Promise<object>} options.executeSql
 *   Resolves `{ok, columns, rows, rowCount, truncated, durationMs, error}`.
 * @param {(event: object) => void} [options.onEvent]
 * @returns {Promise<{status: 'ok'|'step_limit'|'empty', answer: string, steps: number,
 *   queries: Array<object>,
 *   usage: {inputTokens: number, cachedInputTokens: number, outputTokens: number, calls: number}}>}
 *   A failed model call throws: the transport has already retried it, and the
 *   caller records the turn as an error.
 */
export async function runChatTurn({
  client,
  model,
  system,
  history = [],
  question,
  executeSql,
  onEvent = () => {},
  maxSteps = MAX_STEPS,
  maxTokens = 8000
}) {
  const messages = [...history, { role: 'user', content: question }];
  const queries = [];
  const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, calls: 0 };

  for (let step = 1; step <= maxSteps; step += 1) {
    const final = step === maxSteps;
    if (final) messages.push({ role: 'system', content: FINAL_STEP_NOTE });
    onEvent({ type: 'thinking', step });

    const turn = await client.completeWithTools({
      model,
      system,
      messages,
      tools: [EXECUTE_SQL_TOOL],
      toolChoice: final ? 'none' : 'auto',
      maxTokens,
      pass: 'other'
    });
    addUsage(usage, turn.usage);

    // The last step answers whatever came back: tool calls asked for there are
    // not run, since nothing could read their results.
    if (turn.toolCalls.length === 0 || final) {
      const answer = String(turn.content ?? '').trim();
      if (answer) return { status: 'ok', answer, steps: step, queries, usage };
      return {
        status: final ? 'step_limit' : 'empty',
        answer: final ? STEP_LIMIT_ANSWER : EMPTY_ANSWER,
        steps: step,
        queries,
        usage
      };
    }

    messages.push({
      role: 'assistant',
      content: turn.message?.content ?? null,
      tool_calls: turn.message?.tool_calls ?? []
    });
    for (const call of turn.toolCalls) {
      const { query, modelText } = await runToolCall(call, step, executeSql, onEvent);
      if (query) queries.push(query);
      messages.push({ role: 'tool', tool_call_id: call.id, content: modelText });
    }
  }

  return { status: 'step_limit', answer: STEP_LIMIT_ANSWER, steps: maxSteps, queries, usage };
}

async function runToolCall(call, step, executeSql, onEvent) {
  if (call.name !== EXECUTE_SQL_TOOL.function.name) {
    return { query: null, modelText: `Error: there is no tool called ${call.name}. The only tool is execute_sql.` };
  }
  if (!call.args || typeof call.args.sql !== 'string') {
    const detail = call.argsError ? ` (${call.argsError})` : '';
    return {
      query: null,
      modelText: `Error: the arguments were not JSON with an "sql" string${detail}. Call execute_sql again with {"sql": "..."}.`
    };
  }

  const sql = call.args.sql;
  onEvent({ type: 'query_started', step, sql });

  let result;
  try {
    result = await executeSql(sql);
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : 'The query could not be run.' };
  }

  const query = {
    step,
    sql,
    ok: Boolean(result.ok),
    columns: result.columns ?? [],
    rows: result.rows ?? [],
    rowCount: result.rowCount ?? 0,
    truncated: Boolean(result.truncated),
    durationMs: result.durationMs ?? 0,
    error: result.ok ? null : result.error ?? 'The query failed.'
  };
  onEvent({ type: 'query_finished', query });
  return { query, modelText: resultForModel(query) };
}

/**
 * What the model reads back from one query.
 *
 * A header line of counts, then one JSON array per row. The notes are not
 * decoration: a query cut off at the row limit makes any total over its rows
 * wrong, and the model has to be told that in so many words or it will add
 * them up.
 */
export function resultForModel(query) {
  if (!query.ok) {
    return `Error: ${query.error}\nFix the query and try again, or tell the user this cannot be answered from the data.`;
  }

  const lines = [];
  let size = 0;
  for (const row of query.rows.slice(0, MAX_ROWS_TO_MODEL)) {
    const line = JSON.stringify(row.map(clipCell));
    if (size + line.length > MAX_RESULT_CHARS) break;
    lines.push(line);
    size += line.length;
  }

  const header = {
    row_count: query.rowCount,
    cut_off_at_limit: query.truncated,
    rows_shown: lines.length,
    columns: query.columns
  };
  const notes = [];
  if (query.truncated) {
    notes.push(
      `NOTE: the query returned more than ${MAX_ROWS} rows and was cut off at ${MAX_ROWS}. ` +
        'Any total computed from these rows is wrong: aggregate in SQL.'
    );
  } else if (lines.length < query.rowCount) {
    notes.push(`NOTE: only the first ${lines.length} of ${query.rowCount} rows are shown. Aggregate in SQL instead.`);
  }
  return [JSON.stringify(header), ...lines, ...notes].join('\n');
}

function clipCell(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const text = typeof value === 'object' ? JSON.stringify(value) : value;
  if (typeof text === 'string' && text.length > MAX_CELL_CHARS) return `${text.slice(0, MAX_CELL_CHARS)}…`;
  return text;
}

/**
 * Earlier turns of a conversation, as messages for a follow-up.
 *
 * THE QUERIES TRAVEL, THE ROWS DO NOT. A follow-up ("and last year?") needs to
 * know how the previous figure was computed, and the SQL says that exactly; the
 * rows would be stale, large, and an invitation to answer from memory instead of
 * querying again.
 *
 * @param {Array<{question: string, answer: string, queries?: Array<{sql: string, rowCount?: number, error?: string|null}>}>} turns
 */
export function buildHistory(turns, { maxTurns = MAX_HISTORY_TURNS } = {}) {
  return (turns ?? []).slice(-maxTurns).flatMap((turn) => {
    const ran = (turn.queries ?? []).map((query, index) => {
      const outcome = query.error ? `failed: ${query.error}` : `${query.rowCount ?? 0} rows`;
      return `${index + 1}. (${outcome}) ${query.sql}`;
    });
    const note = ran.length
      ? `\n\n[Internal note, not part of the answer. Queries run for it:\n${ran.join('\n')}]`
      : '';
    return [
      { role: 'user', content: turn.question },
      { role: 'assistant', content: `${turn.answer ?? ''}${note}` }
    ];
  });
}

function addUsage(total, usage) {
  total.calls += 1;
  if (!usage) return;
  total.inputTokens += count(usage.prompt_tokens);
  total.outputTokens += count(usage.completion_tokens);
  total.cachedInputTokens += count(usage.prompt_tokens_details?.cached_tokens);
}

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

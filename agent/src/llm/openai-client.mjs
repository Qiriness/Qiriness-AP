import { noopUsageSink } from './usage-sink.mjs';

// Thin, dependency-free wrapper over the OpenAI Chat Completions endpoint,
// matching scripts/lib/embeddings/openai-embeddings-client.mjs (raw fetch,
// injectable fetch/sleep, retry on 429/5xx). Shared by the spam classifier, the
// categoriser and the investigation agent.
//
// Two entry points, one transport:
//   completeJson       — one call, constrained to a JSON schema. Classification.
//   completeWithTools  — one call that may come back asking to run tools.
//
// completeWithTools does ONE round trip and returns what came back. The loop —
// budget, ledger, when to stop — lives in the caller (investigation/investigate.mjs),
// not here, so this file stays a transport and the agent's guardrails stay
// somewhere they can be unit-tested without a network.
//
// WHAT IT COSTS IS RECORDED HERE, at the transport, for the same reason: this is
// the one place both entry points pass through, so one `usageSink.record` covers
// every model call the agent makes. Capturing per call site instead would have
// meant four edits, and `completeJson` — which discards everything but the
// parsed content — could not have reported anything at all.

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const MAX_RETRIES = 3;

// A 429 IS A WINDOW, NOT A BLIP. gpt-4o on this account is capped at 30k tokens
// per minute; the old 250 ms-doubling backoff gave up after under two seconds,
// and on 2026-09-14 about half of some investigation batches failed that way.
// A 429 now waits what OpenAI says (or 2 s doubling), up to a minute a time, and
// gets more attempts than a 5xx — roughly two minutes before it gives up.
const MAX_RATE_LIMIT_RETRIES = 6;
const RATE_LIMIT_MAX_WAIT_MS = 60000;
const RATE_LIMIT_MIN_WAIT_MS = 500;

/**
 * @param {object} [options]
 * @param {string} [options.apiKey]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(ms: number) => Promise<void>} [options.sleepImpl]
 * @param {{record: (entry: object) => void}} [options.usageSink]
 */
export function createOpenAIClient({
  apiKey,
  fetchImpl = fetch,
  sleepImpl = defaultSleep,
  // Where the token counts go. The no-op default keeps every caller that does
  // not care — the eval scripts, the CLIs, the tests — behaving as before.
  usageSink = noopUsageSink
} = {}) {
  if (!apiKey) {
    throw new Error('OpenAI API key is missing. Set OPENAI_API_KEY.');
  }

  /**
   * The shared transport: POST, retry 429/5xx and transport errors, return the
   * parsed payload. Both entry points differ only in the body they build and the
   * part of the response they read.
   *
   * ONE USAGE ROW PER HTTP CALL, and the retries inside `send` are deliberately
   * not rows of their own: a retried 429 was never billed, so counting it would
   * invent spend. A call that runs out of retries IS a row — the last attempt
   * may well have been served and charged before the connection died, and a
   * cost ledger that only records what succeeded under-reports exactly when
   * things are going wrong.
   *
   * `pass` and `ticketId` come from the call site because the transport cannot
   * know either: it sees a body and a model, not which stage of the pipeline
   * asked or which ticket it was working on.
   */
  async function request(body, { pass = 'other', ticketId = null } = {}) {
    let payload;
    try {
      payload = await send(body);
    } catch (error) {
      usageSink.record({
        pass,
        model: body.model,
        ticketId,
        usage: null,
        succeeded: false,
        // A classification, never the message: OpenAI error bodies can echo the
        // request back, and this string is stored.
        errorKind: error.errorKind ?? 'unknown'
      });
      // Rethrown untouched — the caller's retry, fallback and fail-open paths
      // all read this error, and none of them are this module's business.
      throw error;
    }

    usageSink.record({ pass, model: body.model, ticketId, usage: payload?.usage ?? null });
    return payload;
  }

  async function send(body) {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      let response;
      try {
        response = await fetchImpl(OPENAI_CHAT_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
      } catch (error) {
        if (attempt <= MAX_RETRIES) {
          await sleepImpl(backoffMs(attempt));
          continue;
        }
        throw kinded(new Error(`OpenAI request failed: ${error.message}`), 'transport');
      }

      if (response.ok) {
        return response.json();
      }

      if (response.status === 429 && attempt <= MAX_RATE_LIMIT_RETRIES) {
        await sleepImpl(rateLimitWaitMs(response, attempt));
        continue;
      }

      if (response.status >= 500 && attempt <= MAX_RETRIES) {
        await sleepImpl(backoffMs(attempt));
        continue;
      }

      const detail = await response.text().catch(() => `HTTP ${response.status}`);
      throw kinded(
        new Error(`OpenAI request failed (${response.status}): ${detail}`),
        `http_${response.status}`
      );
    }
  }

  // Runs a chat completion constrained to a JSON schema (Structured Outputs) and
  // returns the parsed object. Deterministic (temperature 0) for classification.
  //
  // `pass` and `ticketId` are bookkeeping only: they never reach the request
  // body, and the return shape is the parsed object exactly as before. They
  // exist because this entry point reads only `choices[0].message.content` and
  // therefore threw the usage object away before anyone could count it.
  async function completeJson({
    model,
    system,
    user,
    schema,
    schemaName = 'result',
    maxTokens = 400,
    pass = 'other',
    ticketId = null
  }) {
    const payload = await request(
      {
        model,
        ...samplingParams(model, maxTokens),
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user }
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: schemaName, schema, strict: true }
        }
      },
      { pass, ticketId }
    );

    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('OpenAI response had no content.');
    }
    return JSON.parse(content);
  }

  /**
   * One tool-calling round trip.
   *
   * `messages` is the full conversation the caller maintains (including the
   * `tool` role results of previous rounds) — this function holds no state
   * between calls, which is what lets the agent loop be tested by replaying a
   * scripted sequence.
   *
   * Pass `schema` on the turn where the caller wants the final structured
   * answer; pair it with `toolChoice: 'none'` so the model cannot spend that
   * turn asking for another tool instead of answering.
   *
   * MALFORMED ARGUMENTS ARE RETURNED, NOT THROWN. `arguments` is a JSON string
   * the model wrote, so it can be truncated or invalid. Throwing here would lose
   * a whole investigation over one bad call; returning `args: null` with the
   * error lets the loop hand the model its own mistake and carry on — which is
   * the only route by which it can correct it.
   */
  async function completeWithTools({
    model,
    system,
    messages = [],
    tools,
    toolChoice = 'auto',
    schema = null,
    schemaName = 'result',
    maxTokens = 800,
    pass = 'other',
    ticketId = null
  }) {
    const payload = await request(
      {
        model,
        ...samplingParams(model, maxTokens),
        messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
        ...(tools && tools.length > 0 ? { tools, tool_choice: toolChoice } : {}),
        ...(schema
          ? {
              response_format: {
                type: 'json_schema',
                json_schema: { name: schemaName, schema, strict: true }
              }
            }
          : {})
      },
      { pass, ticketId }
    );

    const message = payload.choices?.[0]?.message || {};
    return {
      message,
      content: message.content ?? null,
      toolCalls: (message.tool_calls || []).map(parseToolCall),
      finishReason: payload.choices?.[0]?.finish_reason ?? null,
      usage: payload.usage ?? null
    };
  }

  return { completeJson, completeWithTools };
}

/**
 * Reasoning models — the gpt-5 family and the o-series — refuse `temperature`
 * and `max_tokens`. They take `max_completion_tokens` instead, and that budget
 * also has to cover the reasoning they never show. Every model the worker calls
 * is on the older shape, so this changes nothing for it; the management chat
 * (web/lib/server/chat/) is the caller on a reasoning model.
 */
export function isReasoningModel(model) {
  return /^(gpt-5|o\d)/.test(String(model ?? ''));
}

function samplingParams(model, maxTokens) {
  return isReasoningModel(model)
    ? { max_completion_tokens: maxTokens }
    : { temperature: 0, max_tokens: maxTokens };
}

function parseToolCall(call) {
  const raw = call?.function?.arguments;
  try {
    return {
      id: call?.id ?? null,
      name: call?.function?.name ?? null,
      args: raw ? JSON.parse(raw) : {},
      argsError: null
    };
  } catch (error) {
    return {
      id: call?.id ?? null,
      name: call?.function?.name ?? null,
      args: null,
      argsError: error.message
    };
  }
}

/**
 * Stamps an error with the class of failure, for the usage row.
 *
 * A SEPARATE FIELD RATHER THAN PARSING THE MESSAGE, because the message carries
 * the response body — which on a 400 is OpenAI quoting the request back, prompt
 * text included — and `error_kind` is stored. The message itself is untouched:
 * callers (and their tests) still match on it.
 */
function kinded(error, errorKind) {
  error.errorKind = errorKind;
  return error;
}

function backoffMs(attempt) {
  return 250 * 2 ** (attempt - 1);
}

/**
 * How long to wait after a 429, in ms.
 *
 * OpenAI's own hint wins when there is one: `retry-after-ms`, then
 * `retry-after` (seconds), then the reset clocks (`x-ratelimit-reset-tokens`,
 * `x-ratelimit-reset-requests`, written like `6m0s` or `120ms`). Without a hint,
 * 2 s doubling. Clamped both ways — never a busy loop, never a stalled worker.
 */
export function rateLimitWaitMs(response, attempt) {
  const header = (name) => response?.headers?.get?.(name) ?? null;
  const hinted =
    parseNumber(header('retry-after-ms')) ??
    secondsToMs(parseNumber(header('retry-after'))) ??
    parseDuration(header('x-ratelimit-reset-tokens')) ??
    parseDuration(header('x-ratelimit-reset-requests'));
  const wait = hinted ?? 2000 * 2 ** (attempt - 1);
  return Math.min(Math.max(wait, RATE_LIMIT_MIN_WAIT_MS), RATE_LIMIT_MAX_WAIT_MS);
}

function parseNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function secondsToMs(seconds) {
  return seconds === null ? null : seconds * 1000;
}

function parseDuration(value) {
  if (!value) return null;
  const units = { ms: 1, s: 1000, m: 60000, h: 3600000 };
  let total = 0;
  let matched = false;
  for (const [, amount, unit] of String(value).matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    total += Number(amount) * units[unit];
    matched = true;
  }
  return matched ? total : null;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

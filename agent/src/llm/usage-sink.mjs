// What each model call cost, collected where the call actually happens.
//
// WHY A SINK AND NOT A WRITE. The token counts arrive on the OpenAI response, at
// the transport — the one place that sees every call from every pass. But the
// transport knows nothing about shops, tickets or Supabase, and writing a row
// there would put a database round trip inside the retry loop of every model
// call: a bookkeeping write that can fail is the last thing that belongs between
// a ticket and its categorisation. So the transport records into memory and the
// caller drains once per pass or poll (see usage-store.mjs).
//
// THE DEFAULT IS THE NO-OP BELOW, everywhere. Every existing caller — the eval
// scripts, the CLIs, the whole test suite — passes no sink and therefore behaves
// exactly as it did before this module existed.

/**
 * The `pass` values `llm_usage_pass_check` accepts (06_analytics.sql).
 *
 * Checked here rather than trusted from the call site because the flush is a
 * BULK insert: one row with a typo'd pass name would take the whole batch's
 * worth of cost history down with it, and the caller that mistyped it is not the
 * one that finds out. An unrecognised value is recorded as 'other', which is
 * wrong in the small and still counts the money.
 */
export const USAGE_PASSES = Object.freeze([
  'spam',
  'categorise',
  'decompose',
  'investigate',
  'draft',
  'embed',
  'other'
]);

const PASS_SET = new Set(USAGE_PASSES);

/**
 * A buffer of usage entries.
 *
 * @param {object} [options]
 * @param {() => Date} [options.now]  injectable clock, so a test can assert the
 *   stamp without freezing time globally.
 */
export function createUsageSink({ now = () => new Date() } = {}) {
  const entries = [];

  return {
    /**
     * One call, recorded.
     *
     * `usage` is OpenAI's own object, taken verbatim off the response —
     * `{prompt_tokens, completion_tokens, total_tokens}` on chat completions,
     * and `{prompt_tokens, total_tokens}` on embeddings, which have no
     * completion half. Null when the call never produced a response at all.
     *
     * NEVER THROWS. This is bookkeeping riding beside real work: a malformed
     * usage object must cost a ticket nothing, so every field is coerced rather
     * than validated.
     */
    record({
      pass = 'other',
      model = null,
      ticketId = null,
      usage = null,
      succeeded = true,
      errorKind = null
    } = {}) {
      const inputTokens = toCount(usage?.prompt_tokens ?? usage?.input_tokens);
      const outputTokens = toCount(usage?.completion_tokens ?? usage?.output_tokens);
      // HOW MANY OF THOSE INPUT TOKENS CAME FROM THE PROMPT CACHE. Nested under
      // `prompt_tokens_details` on chat completions and absent everywhere else,
      // including embeddings — so a missing field reads as zero rather than as a
      // fault. Coerced like every other count here: bookkeeping must not throw.
      const cachedInputTokens = toCount(
        usage?.prompt_tokens_details?.cached_tokens ?? usage?.cached_tokens
      );
      const entry = {
        pass: PASS_SET.has(pass) ? pass : 'other',
        // The model is what the bill is priced against, so an unknown one is
        // recorded under a name rather than dropped — a row that cannot be
        // priced still says a call was made.
        model: model || 'unknown',
        ticketId: ticketId ?? null,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        // Trusted from the response where it exists: OpenAI counts cached and
        // reasoning tokens into the total, and re-deriving it from the two
        // halves would quietly under-report those.
        totalTokens: toCount(usage?.total_tokens ?? inputTokens + outputTokens),
        callCount: 1,
        succeeded: succeeded !== false,
        // A short classification, never an error message: OpenAI echoes request
        // content back in some error bodies, and this string is stored.
        errorKind: errorKind ?? null,
        occurredAt: now().toISOString()
      };
      entries.push(entry);
      return entry;
    },

    /** How much is waiting. Read by callers that log what they flushed. */
    get size() {
      return entries.length;
    },

    /** Hands over everything buffered and empties the buffer. */
    drain() {
      return entries.splice(0, entries.length);
    }
  };
}

/**
 * The sink used when nobody asked for one.
 *
 * Frozen and shared: it holds no state, so a single instance serves every
 * caller, and freezing it means a caller cannot accidentally turn the global
 * default into a buffer that nothing ever drains.
 */
export const noopUsageSink = Object.freeze({
  record() {},
  drain() {
    return [];
  }
});

/**
 * Token counts are `integer not null default 0 check (>= 0)` in the table. A
 * missing, negative or non-numeric value becomes 0 here rather than failing the
 * insert of an entire batch at flush time.
 */
function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

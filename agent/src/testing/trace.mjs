// What the run did, recorded as it happens.
//
// THE PIPELINE GIVES NO ACCOUNT OF ITSELF, by design. `ticket_investigations`
// stores `tool_calls` as `{id, tool, argsHash, outcome}` and `ticket_drafts`
// stores `prompt_inputs` as counts and ids — both deliberately, because they are
// storage for hundreds of real tickets and the alternative is keeping every
// prompt for every email forever. Neither answers the question this feature
// exists for: what was the model actually shown, and what did each tool actually
// say back.
//
// So the trace is assembled at run time, from three sources, and none of them
// required changing what a pass does:
//
//   1. the runners' own `onResult` / `onDraft` callbacks, which already exist;
//   2. `onToolCall` on the investigator, which hands over the whole ledger
//      entry including the French text the model received;
//   3. a decorator around the OpenAI client, which sees every call from every
//      pass — system prompt, messages, tools offered, response, tokens.
//
// The third is why no prompt-composing module needed a hook: the composed
// drafting prompt IS the user message `completeJson` is handed.
//
// PERSONAL DATA. A trace holds the prompts, and the prompts hold whatever the
// tool layer decided a model may see — which is already the narrow view (no
// address, no phone, the customer's email withheld unless asked). It also holds
// the message the OPERATOR typed, which is invented. What it must never gain is
// a raw database row: `data` on a tool entry is capped and shaped below rather
// than passed through.

/** Every step type a trace can carry, in the order a run emits them. */
export const STEPS = Object.freeze([
  'input',
  'gate',
  'identity',
  'categorise',
  'decompose',
  'tool',
  'case_file',
  'order_resolution',
  'order_context',
  'draft',
  'article',
  'error'
]);

const STEP_SET = new Set(STEPS);

/**
 * @param options.now  injectable clock, so a test can assert stamps.
 */
export function createTrace({ now = () => new Date() } = {}) {
  const events = [];
  const tokens = { input: 0, output: 0, total: 0, calls: 0 };

  return {
    get events() {
      return events;
    },

    get tokens() {
      return { ...tokens };
    },

    /**
     * One step. Unknown types throw rather than being recorded: the renderer
     * switches on this, and a typo would produce a step nobody ever sees.
     */
    step(type, payload = {}) {
      if (!STEP_SET.has(type)) {
        throw new Error(`Unknown trace step: ${type}. Known: ${STEPS.join(', ')}`);
      }
      const event = { type, at: now().toISOString(), ...payload };
      events.push(event);
      return event;
    },

    /** Token counts, accumulated from the sink below. */
    countUsage(entry) {
      tokens.input += entry?.inputTokens || 0;
      tokens.output += entry?.outputTokens || 0;
      tokens.total += entry?.totalTokens || 0;
      tokens.calls += entry?.callCount || 1;
    }
  };
}

/**
 * A usage sink that totals into the trace instead of into `llm_usage`.
 *
 * A rehearsal spends real money and none of it is the cost of handling the
 * mailbox, which is the only question `llm_usage` answers — see DECISIONS.md
 * § Agent test chat. The same interface, so the OpenAI client is unaware.
 */
export function createTraceUsageSink(trace) {
  return {
    record(entry = {}) {
      const counted = {
        inputTokens: count(entry.usage?.prompt_tokens ?? entry.usage?.input_tokens),
        outputTokens: count(entry.usage?.completion_tokens ?? entry.usage?.output_tokens),
        callCount: 1
      };
      counted.totalTokens = count(entry.usage?.total_tokens) || counted.inputTokens + counted.outputTokens;
      trace.countUsage(counted);
      return counted;
    },
    drain() {
      return [];
    }
  };
}

/**
 * The OpenAI client, wrapped so every call is recorded.
 *
 * A DECORATOR RATHER THAN A HOOK IN EACH PASS. There are five call sites across
 * four modules and they would each have needed the same three lines; more to the
 * point, a hook per pass records what that pass THINKS it sent, while this
 * records what was sent. The distinction is the entire value of the tool.
 *
 * The wrapped calls are otherwise transparent: same arguments, same return
 * value, same exceptions. A failure is recorded and then rethrown, because a
 * pass's own failure handling is part of what a rehearsal is showing.
 *
 * Tokens are NOT counted here. They arrive on the response inside the client and
 * are already handed to its `usageSink` — `createTraceUsageSink` above is the
 * one that catches them, so there is exactly one counter rather than two that
 * can disagree.
 */
export function traceOpenAI(openai, { maxChars = 20000 } = {}) {
  // Model calls are NOT trace steps. They are collected here and attached to the
  // step that asked for them, because a run makes six or seven of them and a
  // transcript that interleaved them with the pipeline's steps would read as
  // noise rather than as "this is what the categoriser sent".
  const calls = [];

  const remember = (entry) => {
    calls.push(entry);
    return entry;
  };

  return {
    /** Every model call made so far, oldest first. */
    calls,

    /** The calls a given pass made, for attaching to that pass's step. */
    callsFor(pass) {
      return calls.filter((entry) => entry.pass === pass);
    },

    async completeJson(args) {
      const started = Date.now();
      try {
        const result = await openai.completeJson(args);
        remember({
          pass: args.pass || 'other',
          model: args.model || null,
          system: cap(args.system, maxChars),
          messages: [{ role: 'user', content: cap(args.user, maxChars) }],
          tools: [],
          response: cap(JSON.stringify(result), maxChars),
          ms: Date.now() - started,
          failed: false
        });
        return result;
      } catch (error) {
        remember({
          pass: args.pass || 'other',
          model: args.model || null,
          system: cap(args.system, maxChars),
          messages: [{ role: 'user', content: cap(args.user, maxChars) }],
          tools: [],
          response: null,
          ms: Date.now() - started,
          failed: true,
          error: error.message
        });
        throw error;
      }
    },

    async completeWithTools(args) {
      const started = Date.now();
      try {
        const result = await openai.completeWithTools(args);
        remember({
          pass: args.pass || 'other',
          model: args.model || null,
          system: cap(args.system, maxChars),
          messages: (args.messages || []).map((message) => ({
            role: message.role,
            content: cap(contentOf(message), maxChars),
            ...(message.tool_calls
              ? { toolCalls: message.tool_calls.map((c) => c?.function?.name).filter(Boolean) }
              : {})
          })),
          // The names offered on this turn, not the whole definitions: the
          // definitions are static per subject and repeating them on every turn
          // would be most of the trace's size for none of its information.
          tools: (args.tools || []).map((tool) => tool?.function?.name || tool?.name).filter(Boolean),
          toolChoice: args.toolChoice || 'auto',
          response: cap(
            result?.content ??
              (result?.toolCalls?.length
                ? `→ ${result.toolCalls.map((c) => c.name).join(', ')}`
                : ''),
            maxChars
          ),
          ms: Date.now() - started,
          failed: false
        });
        return result;
      } catch (error) {
        remember({
          pass: args.pass || 'other',
          model: args.model || null,
          system: cap(args.system, maxChars),
          messages: (args.messages || []).map((message) => ({
            role: message.role,
            content: cap(contentOf(message), maxChars)
          })),
          tools: [],
          response: null,
          ms: Date.now() - started,
          failed: true,
          error: error.message
        });
        throw error;
      }
    }
  };
}

/**
 * One tool call, shaped for a person to read.
 *
 * `promptText` travels WHOLE — it is the point, the exact French the model was
 * handed — while `data` is reduced to the few fields that say something a person
 * could act on. `data` carries raw-ish tool output (product titles, promotion
 * checks, knowledge candidates) and passing it through would put database
 * shapes, and eventually a column somebody adds later, into a stored trace.
 */
export function toolEntry(entry) {
  return {
    id: entry.id,
    tool: entry.tool,
    args: entry.args ?? null,
    source: entry.source || 'model',
    outcome: entry.outcome ?? null,
    caveats: entry.caveats || [],
    promptText: entry.promptText ?? null,
    detail: detailOf(entry)
  };
}

/**
 * The `data` fields worth showing, per tool, named explicitly.
 *
 * An allow-list rather than a redaction list: a tool that grows a field shows
 * nothing new here until somebody decides it should, which is the correct
 * default for an object that gets stored.
 */
function detailOf(entry) {
  const data = entry?.data || {};
  const detail = {};
  if (Array.isArray(data.titles) && data.titles.length > 0) detail.matchedProducts = data.titles;
  if (Array.isArray(data.candidates) && data.candidates.length > 0) {
    // The whole reported ranking, not a preview: `article-check.mjs` derives
    // "not retrieved" from this list being empty of a document, so truncating
    // it here would turn an outranked article into a missing one.
    detail.candidates = data.candidates.map(shapeCandidate);
  }
  if (Array.isArray(data.codes) && data.codes.length > 0) detail.codes = data.codes;
  if (typeof data.verdict === 'string') detail.verdict = data.verdict;
  if (typeof data.bestSimilarity === 'number') detail.bestSimilarity = round(data.bestSimilarity);
  if (Array.isArray(data.chunks)) {
    detail.chunksGiven = data.chunks.map((chunk) => ({
      documentId: chunk?.documentId ?? null,
      title: chunk?.title ?? null,
      similarity: round(chunk?.similarity)
    }));
  }
  if (data.profile) detail.customer = data.profile;
  if (data.account) detail.account = data.account;
  return detail;
}

/**
 * A retrieval candidate. Knowledge candidates carry a document id and a score;
 * a product matcher's near-miss carries a title. Both are already summaries.
 */
function shapeCandidate(candidate) {
  if (candidate && typeof candidate === 'object') {
    return {
      // The chunk id is what makes two searches finding the same chunk one
      // candidate rather than two — see rankCandidates in article-check.mjs.
      chunkId: candidate.chunkId ?? null,
      documentId: candidate.documentId ?? null,
      title: candidate.title ?? null,
      heading: candidate.heading ?? null,
      similarity: round(candidate.similarity)
    };
  }
  return { title: String(candidate) };
}

function round(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(3)) : null;
}

function contentOf(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.map((part) => part?.text || '').join('');
  }
  return '';
}

function cap(value, maxChars) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n… [${text.length - maxChars} more characters]`;
}

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

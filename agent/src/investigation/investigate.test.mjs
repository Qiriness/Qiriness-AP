import assert from 'node:assert/strict';
import test from 'node:test';

import { createInvestigator } from './investigate.mjs';
import { FINALIZE_TOOL_NAME } from './case-file.mjs';
import { TOOL_NAMES } from './investigation-rules.mjs';

const PRODUCT_TICKET = {
  id: 't1',
  subject: 'Masque LED',
  text: 'le masque LED convient-il aux peaux sensibles ?',
  category: 'product',
  request_kind: 'question',
  level: 1
};

/** A registry that records every call, with whatever handlers a test needs. */
function buildRegistry(handlerMap, names = Object.keys(handlerMap)) {
  const calls = [];
  const handlers = new Map(
    Object.entries(handlerMap).map(([name, fn]) => [
      name,
      async (args) => {
        calls.push({ name, args });
        return fn(args);
      }
    ])
  );
  return {
    calls,
    toolsFor() {
      return {
        names,
        definitions: names.map((name) => ({ type: 'function', function: { name } })),
        handlers
      };
    }
  };
}

const OK_RESULT = { outcome: 'found', caveats: [], promptText: 'résultat', data: {} };

/** Replays a scripted sequence of model turns. */
function buildOpenAI(turns) {
  const sent = [];
  let index = 0;
  return {
    sent,
    async completeWithTools(request) {
      sent.push(request);
      const turn = turns[index] || turns[turns.length - 1];
      index += 1;

      // A scripted turn carrying `content` and no tool calls is the CLOSING
      // turn. Since 2026-09-07 the case file comes back as a forced
      // `finalize_investigation` tool call rather than as message content — see
      // case-file.mjs § FINALIZE_TOOL — so the double emits it in that shape
      // while tests go on writing the case file as a JSON string.
      if (turn.content !== undefined && !turn.toolCalls) {
        let args = null;
        let argsError = null;
        try {
          args = JSON.parse(turn.content);
        } catch (error) {
          argsError = error.message;
        }
        const raw = {
          id: 'final',
          type: 'function',
          function: { name: FINALIZE_TOOL_NAME, arguments: turn.content }
        };
        return {
          message: { role: 'assistant', content: null, tool_calls: [raw] },
          content: null,
          toolCalls: [{ id: 'final', name: FINALIZE_TOOL_NAME, args, argsError }],
          finishReason: null,
          usage: null
        };
      }

      return {
        message: { role: 'assistant', content: turn.content ?? null, tool_calls: turn.rawToolCalls },
        content: turn.content ?? null,
        toolCalls: turn.toolCalls || [],
        finishReason: null,
        usage: null
      };
    }
  };
}

function caseFileAnswer(overrides = {}) {
  return JSON.stringify({
    verdict: 'answerable',
    established: [{ claim: 'Le masque convient aux peaux sensibles.', evidence_ids: ['t1'] }],
    unverified: [],
    missing: [],
    handoff: null,
    ...overrides
  });
}

test('a ticket with no allowed tools is decided without a model call', async () => {
  // Level 4, `contact` and legal_privacy all land here.
  const openai = buildOpenAI([{ content: caseFileAnswer() }]);
  const registry = { toolsFor: () => ({ names: [], definitions: [], handlers: new Map() }) };
  const { investigate } = createInvestigator(openai, registry, { model: 'm' });

  const caseFile = await investigate({ ...PRODUCT_TICKET, level: 4 });

  assert.equal(caseFile.verdict, 'needs_human');
  assert.equal(openai.sent.length, 0, 'no tokens spent on a ticket that is out of scope');
  assert.ok(caseFile.handoff.why.includes('Aucun outil'));
});

test('opening moves run before the model speaks', async () => {
  const registry = buildRegistry({
    [TOOL_NAMES.LOOKUP_PRODUCT]: async () => OK_RESULT,
    [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => ({ ...OK_RESULT, data: { chunks: [{ title: 'FAQ', text: 'x' }] } })
  });
  const openai = buildOpenAI([{ content: caseFileAnswer() }]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm' });

  const caseFile = await investigate(PRODUCT_TICKET);

  assert.deepEqual(registry.calls.map((c) => c.name), [
    TOOL_NAMES.LOOKUP_PRODUCT,
    TOOL_NAMES.SEARCH_KNOWLEDGE
  ]);
  // The model saw them in its first prompt rather than having to ask.
  assert.match(openai.sent[0].messages[0].content, /Éléments déjà recueillis/);
  assert.match(openai.sent[0].messages[0].content, /\[t1\]/);
  assert.equal(caseFile.verdict, 'answerable');
  assert.equal(caseFile.knowledge.length, 1);
});

test('the model can call a further tool and gets the result back with its id', async () => {
  const registry = buildRegistry({
    [TOOL_NAMES.LOOKUP_PRODUCT]: async () => OK_RESULT,
    [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => OK_RESULT,
    [TOOL_NAMES.LOOKUP_STOCK]: async () => ({ ...OK_RESULT, promptText: 'disponible' })
  });
  const openai = buildOpenAI([
    { toolCalls: [{ id: 'c1', name: TOOL_NAMES.LOOKUP_STOCK, args: { question: 'x' }, argsError: null }] },
    { content: caseFileAnswer() }
  ]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm' });

  await investigate(PRODUCT_TICKET);

  const toolMessage = openai.sent[1].messages.find((m) => m.role === 'tool');
  assert.equal(toolMessage.tool_call_id, 'c1');
  assert.match(toolMessage.content, /^\[t3\] disponible/);
});

test('the tool budget is a ceiling, and exhausting it is an outcome not an error', async () => {
  const registry = buildRegistry({
    [TOOL_NAMES.LOOKUP_PRODUCT]: async () => OK_RESULT,
    [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => OK_RESULT,
    [TOOL_NAMES.LOOKUP_STOCK]: async () => OK_RESULT
  });
  // Every turn asks for two more stock lookups with different arguments.
  const greedy = {
    toolCalls: [
      { id: 'a', name: TOOL_NAMES.LOOKUP_STOCK, args: { question: 'a' }, argsError: null },
      { id: 'b', name: TOOL_NAMES.LOOKUP_STOCK, args: { question: 'b' }, argsError: null }
    ]
  };
  // Two opening moves plus this turn's two calls fill a budget of four, so the
  // loop stops asking and goes straight to the closing turn.
  const openai = buildOpenAI([greedy, { content: caseFileAnswer() }]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm', maxToolCalls: 4, maxTurns: 4 });

  const caseFile = await investigate(PRODUCT_TICKET);

  assert.equal(caseFile.toolCalls.length, 4);
  assert.equal(registry.calls.length, 4);
  assert.equal(openai.sent.length, 2, 'no further turn is spent once the budget is gone');
  // The closing instruction tells it the budget is gone rather than letting it
  // conclude as if the missing lookup had happened.
  const closing = openai.sent.at(-1).messages.at(-1).content;
  assert.match(closing, /budget/i);
});

test('an identical call is served from the cache and costs no budget', async () => {
  let executions = 0;
  const registry = buildRegistry({
    [TOOL_NAMES.LOOKUP_PRODUCT]: async () => {
      executions += 1;
      return OK_RESULT;
    },
    [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => OK_RESULT
  });
  const repeat = {
    toolCalls: [
      { id: 'a', name: TOOL_NAMES.LOOKUP_PRODUCT, args: { question: PRODUCT_TICKET.text }, argsError: null }
    ]
  };
  const openai = buildOpenAI([repeat, repeat, { content: caseFileAnswer() }]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm' });

  const caseFile = await investigate(PRODUCT_TICKET);

  assert.equal(executions, 1, 'the opening move ran it; the repeats were cached');
  assert.equal(caseFile.toolCalls.filter((c) => c.tool === TOOL_NAMES.LOOKUP_PRODUCT).length, 1);
});

test('argument order does not make one call look like two', async () => {
  let executions = 0;
  const registry = buildRegistry({
    [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => {
      executions += 1;
      return OK_RESULT;
    }
  });
  const openai = buildOpenAI([
    {
      toolCalls: [
        { id: 'a', name: TOOL_NAMES.SEARCH_KNOWLEDGE, args: { x: 1, y: 2 }, argsError: null },
        { id: 'b', name: TOOL_NAMES.SEARCH_KNOWLEDGE, args: { y: 2, x: 1 }, argsError: null }
      ]
    },
    { content: caseFileAnswer() }
  ]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm' });

  await investigate({ ...PRODUCT_TICKET, category: 'other' });
  assert.equal(executions, 2, 'one opening move plus one distinct model call');
});

test('a failing tool never loses the investigation', async () => {
  const registry = buildRegistry({
    [TOOL_NAMES.LOOKUP_PRODUCT]: async () => {
      throw new Error('supabase down');
    },
    [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => OK_RESULT
  });
  const openai = buildOpenAI([{ content: caseFileAnswer({ established: [] , verdict: 'needs_human' }) }]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm' });

  const caseFile = await investigate(PRODUCT_TICKET);

  assert.equal(caseFile.toolCalls[0].outcome, 'error');
  assert.equal(caseFile.verdict, 'needs_human');
});

test('malformed arguments are handed back to the model rather than thrown', async () => {
  const registry = buildRegistry({
    [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => OK_RESULT
  });
  const openai = buildOpenAI([
    { toolCalls: [{ id: 'a', name: TOOL_NAMES.SEARCH_KNOWLEDGE, args: null, argsError: 'Unexpected end of JSON input' }] },
    { content: caseFileAnswer() }
  ]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm' });

  await investigate({ ...PRODUCT_TICKET, category: 'other' });

  const toolMessage = openai.sent[1].messages.find((m) => m.role === 'tool');
  assert.match(toolMessage.content, /Arguments invalides/);
});

test('the final turn forces the case-file tool instead of a response schema', async () => {
  const registry = buildRegistry({ [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => OK_RESULT });
  const openai = buildOpenAI([{ content: caseFileAnswer() }]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm' });

  await investigate({ ...PRODUCT_TICKET, category: 'other' });

  const final = openai.sent.at(-1);
  assert.deepEqual(final.toolChoice, {
    type: 'function',
    function: { name: FINALIZE_TOOL_NAME }
  });
  // No `response_format` anywhere: carrying one puts the request in a different
  // prompt-cache partition from the loop turns, which cost 100% of the closing
  // call's cache. See codex_plans/Model_Cost_Notes.md § SOLVED 2026-09-07.
  assert.equal(final.schema, undefined);
  assert.equal(final.schemaName, undefined);
});

test('the tool array is identical on every turn, closing call included', async () => {
  // THE PROPERTY THE CACHE FIX RESTS ON. A tools array that differs between the
  // loop and the closing call splits the cache partition again, which is the
  // whole bug — so this is asserted rather than left to reading.
  const registry = buildRegistry({ [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => OK_RESULT });
  const openai = buildOpenAI([
    { toolCalls: [{ id: 'c1', name: TOOL_NAMES.SEARCH_KNOWLEDGE, args: {}, argsError: null }] },
    { content: caseFileAnswer() }
  ]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm' });

  await investigate({ ...PRODUCT_TICKET, category: 'other' });

  assert.ok(openai.sent.length >= 2);
  const shapes = openai.sent.map((request) => JSON.stringify(request.tools));
  assert.equal(new Set(shapes).size, 1);
  assert.ok(openai.sent[0].tools.some((tool) => tool.function.name === FINALIZE_TOOL_NAME));
});

test('a model that finalises mid-loop stops collecting but still closes', async () => {
  // It CAN reach for the tool early, because the tool is offered on every turn.
  // Mapped onto the existing "no tool calls" signal rather than used as an early
  // exit: taking its arguments here would be the suppression trade DECISIONS.md
  // records as measured and reversed.
  const registry = buildRegistry({ [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => OK_RESULT });
  const openai = buildOpenAI([
    {
      toolCalls: [{ id: 'f1', name: FINALIZE_TOOL_NAME, args: {}, argsError: null }],
      rawToolCalls: [
        { id: 'f1', type: 'function', function: { name: FINALIZE_TOOL_NAME, arguments: '{}' } }
      ]
    },
    { content: caseFileAnswer() }
  ]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm' });

  const caseFile = await investigate({ ...PRODUCT_TICKET, category: 'other' });

  // Two calls: the loop turn that finalised, then the closing call that follows
  // it exactly as it follows an empty turn today.
  assert.equal(openai.sent.length, 2);
  assert.equal(caseFile.verdict, 'answerable');
  // The finalise never reached a handler, so it left no ledger entry of its own
  // (the entry that IS there is the opening move, which runs before the model).
  assert.ok(caseFile.toolCalls.every((call) => call.tool !== FINALIZE_TOOL_NAME));
});

test('claims citing a call that never ran are dropped from the case file', async () => {
  // The end-to-end version of the case-file guardrail.
  const registry = buildRegistry({ [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => OK_RESULT });
  const openai = buildOpenAI([
    {
      content: caseFileAnswer({
        established: [
          { claim: 'La base répond.', evidence_ids: ['t1'] },
          { claim: 'Le colis est livré.', evidence_ids: ['t7'] }
        ]
      })
    }
  ]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm' });

  const caseFile = await investigate({ ...PRODUCT_TICKET, category: 'other' });

  assert.deepEqual(caseFile.established.map((f) => f.claim), ['La base répond.']);
  assert.deepEqual(caseFile.droppedClaims, ['Le colis est livré.']);
});

test('a case file that will not parse throws, so the runner can retry', async () => {
  const registry = buildRegistry({ [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => OK_RESULT });
  const openai = buildOpenAI([{ content: '{"verdict": ' }]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm' });

  await assert.rejects(() => investigate({ ...PRODUCT_TICKET, category: 'other' }));
});

// --- decomposition -----------------------------------------------------------

/** A registry that scopes tools by the plan, the way the real one does. */
function buildPlanningRegistry(handlerMap) {
  const registry = buildRegistry(handlerMap);
  const base = registry.toolsFor;
  registry.toolsFor = (ticket, { tasks = null } = {}) => {
    const result = base();
    registry.boundFor = tasks;
    return result;
  };
  return registry;
}

function buildDecomposer(result) {
  const seen = [];
  return {
    seen,
    async decompose(ticket) {
      seen.push(ticket);
      return {
        entities: { order_numbers: [], products: [], codes: [] },
        needs: [],
        read: true,
        ...result
      };
    }
  };
}

test('an out-of-scope ticket is not decomposed either', async () => {
  // The scope check runs on the ticket first, so level 4 costs nothing at all —
  // not an investigation, and not a decomposition call on the way to skipping one.
  const decomposer = buildDecomposer({ tasks: [] });
  const registry = { toolsFor: () => ({ names: [], definitions: [], handlers: new Map() }) };
  const openai = buildOpenAI([{ content: caseFileAnswer() }]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm', decomposer });

  await investigate({ ...PRODUCT_TICKET, level: 4 });

  assert.equal(decomposer.seen.length, 0);
});

test('a split email runs the opening moves of BOTH its subjects', async () => {
  // The failure decomposition exists to fix: today only the primary subject's
  // tools are bound, so the promotion half of this email is never looked at.
  const registry = buildPlanningRegistry({
    [TOOL_NAMES.LOOKUP_PRODUCT]: async () => OK_RESULT,
    [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => OK_RESULT,
    [TOOL_NAMES.EXTRACT_PROMOTION_CODES]: async () => OK_RESULT,
    [TOOL_NAMES.LOOKUP_CUSTOMER]: async () => OK_RESULT
  });
  const decomposer = buildDecomposer({
    tasks: [
      { question: 'Le masque convient-il aux peaux sensibles ?', category: 'product', request_kind: 'question' },
      { question: 'Mon code est refusé', category: 'promotions', request_kind: 'problem' }
    ]
  });
  const openai = buildOpenAI([{ content: caseFileAnswer() }]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm', decomposer });

  await investigate(PRODUCT_TICKET);

  const tools = registry.calls.map((c) => c.name);
  assert.ok(tools.includes(TOOL_NAMES.LOOKUP_PRODUCT));
  assert.ok(tools.includes(TOOL_NAMES.EXTRACT_PROMOTION_CODES));
  // The registry was asked to scope by the plan, not by the ticket alone.
  assert.equal(registry.boundFor.length, 2);
});

test('the model is told to answer every request the email contains', async () => {
  const registry = buildPlanningRegistry({
    [TOOL_NAMES.LOOKUP_PRODUCT]: async () => OK_RESULT,
    [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => OK_RESULT,
    [TOOL_NAMES.EXTRACT_PROMOTION_CODES]: async () => OK_RESULT,
    [TOOL_NAMES.LOOKUP_CUSTOMER]: async () => OK_RESULT
  });
  const decomposer = buildDecomposer({
    tasks: [
      { question: 'Le masque convient-il ?', category: 'product', request_kind: 'question' },
      { question: 'Mon code BIENVENUE10 est refusé', category: 'promotions', request_kind: 'problem' }
    ]
  });
  const openai = buildOpenAI([{ content: caseFileAnswer() }]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm', decomposer });

  await investigate(PRODUCT_TICKET);

  const prompt = openai.sent[0].messages[0].content;
  assert.match(prompt, /plusieurs demandes distinctes/);
  assert.match(prompt, /BIENVENUE10/);
});

test('a request the agent cannot investigate is declared, not dropped', async () => {
  // `legal_privacy` is out of scope by policy, not by data. The case file must
  // say so rather than answer the product half and leave the privacy request
  // unanswered in silence.
  const registry = buildPlanningRegistry({
    [TOOL_NAMES.LOOKUP_PRODUCT]: async () => OK_RESULT,
    [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => OK_RESULT
  });
  const decomposer = buildDecomposer({
    tasks: [
      { question: 'Le masque convient-il ?', category: 'product', request_kind: 'question' },
      { question: 'suppression de mes données personnelles', category: 'legal_privacy', request_kind: 'problem' }
    ]
  });
  const openai = buildOpenAI([{ content: caseFileAnswer() }]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm', decomposer });

  await investigate(PRODUCT_TICKET);

  const prompt = openai.sent[0].messages[0].content;
  assert.match(prompt, /suppression de mes données personnelles/);
  assert.match(prompt, /needs_human/);
});

test('a single-task decomposition is investigated exactly as before', async () => {
  // The no-regression property, end to end: same moves, same prompt shape.
  const handlers = {
    [TOOL_NAMES.LOOKUP_PRODUCT]: async () => OK_RESULT,
    [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => OK_RESULT
  };
  const decomposer = buildDecomposer({
    tasks: [{ question: PRODUCT_TICKET.text, category: 'product', request_kind: 'question' }]
  });

  const withDecomposer = buildPlanningRegistry(handlers);
  const plain = buildRegistry(handlers);
  const a = buildOpenAI([{ content: caseFileAnswer() }]);
  const b = buildOpenAI([{ content: caseFileAnswer() }]);

  await createInvestigator(a, withDecomposer, { model: 'm', decomposer }).investigate(PRODUCT_TICKET);
  await createInvestigator(b, plain, { model: 'm' }).investigate(PRODUCT_TICKET);

  assert.deepEqual(withDecomposer.calls, plain.calls);
  assert.equal(a.sent[0].messages[0].content, b.sent[0].messages[0].content);
});

// --- the evidence report -----------------------------------------------------

test('what the ticket needed is scored against what actually ran', async () => {
  const registry = buildPlanningRegistry({
    [TOOL_NAMES.LOOKUP_PRODUCT]: async () => OK_RESULT,
    [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => ({ ...OK_RESULT, outcome: 'none' })
  });
  const decomposer = buildDecomposer({
    tasks: [{ question: 'Le masque convient-il ?', category: 'product', request_kind: 'question' }],
    // Declared: one the run gets, one it looks for and misses, one this SUBJECT
    // is not given the tool for (a product ticket gets no checkout lookup).
    needs: ['product_identity', 'policy_answer', 'checkout_state']
  });
  const openai = buildOpenAI([{ content: caseFileAnswer() }]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm', decomposer });

  const caseFile = await investigate(PRODUCT_TICKET);
  const byNeed = Object.fromEntries(caseFile.evidenceGaps.map((g) => [g.need, g.state]));

  assert.equal(byNeed.product_identity, 'satisfied');
  assert.equal(byNeed.policy_answer, 'attempted', 'searched, found nothing');
  assert.equal(byNeed.checkout_state, 'unavailable', 'this subject is not given the checkout tool');
});

test('a fact nobody looked for is distinguishable from one nothing could find', async () => {
  // The whole point: today both produce a case file that reads as complete.
  const registry = buildPlanningRegistry({
    [TOOL_NAMES.LOOKUP_PRODUCT]: async () => OK_RESULT,
    [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => OK_RESULT,
    [TOOL_NAMES.LOOKUP_STOCK]: async () => OK_RESULT
  });
  const decomposer = buildDecomposer({
    tasks: [{ question: 'x', category: 'product', request_kind: 'question' }],
    needs: ['product_availability']
  });
  const openai = buildOpenAI([{ content: caseFileAnswer() }]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm', decomposer });

  const caseFile = await investigate(PRODUCT_TICKET);

  // lookupStock was allowed and had budget; nothing called it.
  assert.equal(caseFile.evidenceGaps[0].state, 'not_attempted');
});

// --- the findings trace -----------------------------------------------------

test('every call leaves a snapshot, in call order and keyed to its ledger id', async () => {
  const registry = buildPlanningRegistry({
    [TOOL_NAMES.LOOKUP_PRODUCT]: async () => OK_RESULT,
    [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => ({ ...OK_RESULT, outcome: 'none' })
  });
  const decomposer = buildDecomposer({
    tasks: [{ question: 'Le masque convient-il ?', category: 'product', request_kind: 'question' }],
    needs: ['product_identity', 'policy_answer']
  });
  const openai = buildOpenAI([{ content: caseFileAnswer() }]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm', decomposer });

  const caseFile = await investigate(PRODUCT_TICKET);

  assert.ok(caseFile.toolCalls.length > 1, 'this scenario needs more than one call to be worth testing');
  assert.equal(caseFile.findingsTrace.length, caseFile.toolCalls.length);
  assert.deepEqual(
    caseFile.findingsTrace.map((s) => [s.call, s.tool]),
    caseFile.toolCalls.map((c) => [c.id, c.tool])
  );
});

test('the last snapshot is the same reading the case file itself reports', async () => {
  // THE INVARIANT WORTH PINNING. The trace and `evidence_gaps` are derived from
  // the same ledger by the same function, so the end of the tape must agree with
  // the gaps beside it. If it ever does not, one of the two is being built from
  // a different ledger — which is exactly the bug a replay would inherit
  // silently and act on.
  const registry = buildPlanningRegistry({
    [TOOL_NAMES.LOOKUP_PRODUCT]: async () => OK_RESULT,
    [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => ({ ...OK_RESULT, outcome: 'none' })
  });
  const decomposer = buildDecomposer({
    tasks: [{ question: 'Le masque convient-il ?', category: 'product', request_kind: 'question' }],
    needs: ['product_identity', 'policy_answer']
  });
  const openai = buildOpenAI([{ content: caseFileAnswer() }]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm', decomposer });

  const caseFile = await investigate(PRODUCT_TICKET);
  const last = caseFile.findingsTrace.at(-1).findings;

  for (const gap of caseFile.evidenceGaps) {
    if (gap.finding == null) continue;
    assert.equal(last[gap.need], gap.finding, gap.need);
  }
});

test('the trace scores the whole vocabulary, not just what this ticket declared', async () => {
  // A need nobody declared still gets a reading, because the row can never be
  // recomputed: the tool `data` these are derived from does not survive the run,
  // and a rule authored next month may branch on a need this ticket never named.
  const registry = buildPlanningRegistry({
    [TOOL_NAMES.LOOKUP_PRODUCT]: async () => OK_RESULT,
    [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => ({ ...OK_RESULT, outcome: 'none' })
  });
  const decomposer = buildDecomposer({
    tasks: [{ question: 'x', category: 'product', request_kind: 'question' }],
    needs: ['product_identity']
  });
  const openai = buildOpenAI([{ content: caseFileAnswer() }]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm', decomposer });

  const caseFile = await investigate(PRODUCT_TICKET);
  const last = caseFile.findingsTrace.at(-1).findings;

  assert.equal(caseFile.evidenceGaps.length, 1, 'one need declared');
  assert.ok(Object.keys(last).length > 1, 'the trace reads more than the declared one');
  assert.ok('order_identity' in last, 'a need from another family is still scored');
});

test('a run that called nothing traces nothing, which is not the same as no trace', async () => {
  // `[]` here; NULL in the column means the row predates the trace entirely.
  const openai = buildOpenAI([{ content: caseFileAnswer() }]);
  const registry = { toolsFor: () => ({ names: [], definitions: [], handlers: new Map() }) };
  const { investigate } = createInvestigator(openai, registry, { model: 'm' });

  const caseFile = await investigate({ ...PRODUCT_TICKET, level: 4 });

  assert.deepEqual(caseFile.findingsTrace, []);
});

test('the report does not move the verdict — that is deliberately the next step', async () => {
  const registry = buildPlanningRegistry({
    [TOOL_NAMES.LOOKUP_PRODUCT]: async () => OK_RESULT,
    [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => OK_RESULT
  });
  const decomposer = buildDecomposer({
    tasks: [{ question: 'x', category: 'product', request_kind: 'question' }],
    needs: ['other_fact']
  });
  const openai = buildOpenAI([{ content: caseFileAnswer() }]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm', decomposer });

  const caseFile = await investigate(PRODUCT_TICKET);

  assert.equal(caseFile.evidenceGaps[0].state, 'unavailable');
  assert.equal(caseFile.verdict, 'answerable', 'measurement first; enforcement once the vocabulary is trusted');
});

test('no decomposer means no declared needs rather than invented ones', async () => {
  const registry = buildRegistry({
    [TOOL_NAMES.LOOKUP_PRODUCT]: async () => OK_RESULT,
    [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => OK_RESULT
  });
  const openai = buildOpenAI([{ content: caseFileAnswer() }]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm' });

  const caseFile = await investigate(PRODUCT_TICKET);
  assert.deepEqual(caseFile.evidenceGaps, []);
});

test('caveats from every tool that ran reach the prohibitions', async () => {
  const registry = buildRegistry({
    [TOOL_NAMES.EXTRACT_PROMOTION_CODES]: async () => ({ ...OK_RESULT, caveats: [] }),
    [TOOL_NAMES.LOOKUP_CUSTOMER]: async () => ({ ...OK_RESULT, caveats: ['customer_unknown'] }),
    [TOOL_NAMES.LOOKUP_PROMOTION]: async () => ({
      ...OK_RESULT,
      caveats: ['basket_unseeable', 'eligibility_undetermined']
    })
  });
  const openai = buildOpenAI([
    { toolCalls: [{ id: 'a', name: TOOL_NAMES.LOOKUP_PROMOTION, args: { code: 'X' }, argsError: null }] },
    { content: caseFileAnswer({ established: [{ claim: 'Le code existe.', evidence_ids: ['t3'] }] }) }
  ]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm' });

  const caseFile = await investigate({
    ...PRODUCT_TICKET,
    category: 'promotions',
    request_kind: 'problem',
    level: 2
  });

  assert.equal(caseFile.doNotClaim.length, 3);
  assert.ok(caseFile.doNotClaim.some((l) => l.includes('panier actuel')));
});

/** The user prompt of the first turn — what the model was actually shown. */
const firstPrompt = (openai) => openai.sent[0].messages.find((m) => m.role === 'user').content;

test('a listed sender is described to the model, without its address', async () => {
  const openai = buildOpenAI([{ content: caseFileAnswer() }]);
  const registry = buildRegistry({ [TOOL_NAMES.knowledge]: async () => OK_RESULT });
  const { investigate } = createInvestigator(openai, registry, { model: 'm' });

  await investigate({
    ...PRODUCT_TICKET,
    sender: {
      label: 'retailer',
      note: 'Retail partner. Reorders arrive as attachments.',
      pattern: 'nocibe.fr',
      matched: 'domain'
    }
  });

  const prompt = firstPrompt(openai);
  assert.match(prompt, /Expéditeur : un revendeur/);
  // The domain is business context and belongs here; the note comes with it.
  assert.match(prompt, /nocibe\.fr/);
  assert.match(prompt, /Reorders arrive as attachments/);
});

test('an exact-address match names the label but never the address', async () => {
  const openai = buildOpenAI([{ content: caseFileAnswer() }]);
  const registry = buildRegistry({ [TOOL_NAMES.knowledge]: async () => OK_RESULT });
  const { investigate } = createInvestigator(openai, registry, { model: 'm' });

  await investigate({
    ...PRODUCT_TICKET,
    sender: { label: 'contractor', note: null, pattern: 'patrick@dopweb.com', matched: 'email' }
  });

  const prompt = firstPrompt(openai);
  assert.match(prompt, /Expéditeur : un prestataire/);
  // An exact match means the pattern IS a person's address — it must not be echoed.
  assert.ok(!prompt.includes('patrick@dopweb.com'), 'the sender address must never reach the prompt');
});

test('an ordinary consumer gets no sender line at all', async () => {
  const openai = buildOpenAI([{ content: caseFileAnswer() }]);
  const registry = buildRegistry({ [TOOL_NAMES.knowledge]: async () => OK_RESULT });
  const { investigate } = createInvestigator(openai, registry, { model: 'm' });

  await investigate({ ...PRODUCT_TICKET, sender: null });

  // Restating "ordinary customer" on every ticket would train the reader to skip
  // the line on the ticket where it matters.
  assert.ok(!firstPrompt(openai).includes('Expéditeur'));
});

// --- the decomposition-failure fallback ---------------------------------------

const NEEDS_TOOLS = buildRegistry({ [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => OK_RESULT });
const ANSWER_TURNS = [{ content: caseFileAnswer() }];

test('a matched exemplar stands in only when decomposition produced nothing', async () => {
  // `decompose.mjs` deliberately invents no needs on failure, so the run would
  // otherwise report "nobody said what this required". A human-authored list for
  // a situation this ticket matched is not the guess that rule forbids.
  const { investigate } = createInvestigator(buildOpenAI(ANSWER_TURNS), NEEDS_TOOLS, {
    model: 'm',
    decomposer: { decompose: async () => ({ tasks: [], entities: {}, needs: [], read: false }) }
  });

  const caseFile = await investigate({
    ...PRODUCT_TICKET,
    exemplarNeeds: ['product_property', 'policy_answer']
  });

  assert.equal(caseFile.needsSource, 'exemplar');
  assert.deepEqual(
    caseFile.evidenceGaps.map((g) => g.need).sort(),
    ['policy_answer', 'product_property']
  );
});

test('while the decomposer has spoken the exemplar is ignored entirely', async () => {
  // The independence IS the measurement: if the exemplar could top up a
  // successful decomposition, comparing the two would compare a list to itself.
  const { investigate } = createInvestigator(buildOpenAI(ANSWER_TURNS), NEEDS_TOOLS, {
    model: 'm',
    decomposer: {
      decompose: async () => ({
        tasks: [], entities: {}, needs: ['product_identity'], read: true
      })
    }
  });

  const caseFile = await investigate({
    ...PRODUCT_TICKET,
    exemplarNeeds: ['policy_answer', 'brand_answer']
  });

  assert.equal(caseFile.needsSource, 'model');
  assert.deepEqual(caseFile.evidenceGaps.map((g) => g.need), ['product_identity']);
});

test('a failed decomposition with no exemplar still declares nothing', async () => {
  const { investigate } = createInvestigator(buildOpenAI(ANSWER_TURNS), NEEDS_TOOLS, {
    model: 'm',
    decomposer: { decompose: async () => ({ tasks: [], entities: {}, needs: [], read: false }) }
  });

  const caseFile = await investigate({ ...PRODUCT_TICKET, exemplarNeeds: [] });

  assert.equal(caseFile.needsSource, 'none');
  assert.deepEqual(caseFile.evidenceGaps, []);
});

// --- the article a rule pins -------------------------------------------------

test('the article a rule pins is recorded on the policy block, not resolved here', () => {
  // RECORDED, NOT RESOLVED, for the reason the offer code is: whether the
  // document is still approved is a drafting-time question, and a stored run has
  // to read back which article the rule chose either way.
  const registry = buildPlanningRegistry({
    // `answerable` is the outcome `policy_answer` reads; `found` derives `unknown`.
    [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => ({ ...OK_RESULT, outcome: 'answerable' })
  });
  const decomposer = buildDecomposer({
    tasks: [{ question: 'Livrez-vous en Italie ?', category: 'product', request_kind: 'question' }],
    needs: ['policy_answer']
  });
  const openai = buildOpenAI([{ content: caseFileAnswer() }]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm', decomposer });

  return investigate({
    ...PRODUCT_TICKET,
    policy: {
      answerSet: 'orders',
      situationKey: null,
      answers: [
        {
          answerKey: 'd33_livraison_documentee',
          situationKey: null,
          conditions: { policy_answer: ['answered'] },
          route: null,
          ask: [],
          offerCode: null,
          knowledgeDocumentId: 'doc-33',
          priority: 0,
          isFallback: false
        }
      ]
    }
  }).then((caseFile) => {
    assert.equal(caseFile.policy?.answer_key, 'd33_livraison_documentee');
    assert.equal(caseFile.policy?.knowledge_document_id, 'doc-33');
  });
});

test('a rule with no pinned article records null rather than omitting the field', () => {
  // Omitting it would make "no article" and "written before pinning existed"
  // the same row, which is the distinction a replay would need.
  const registry = buildPlanningRegistry({
    // `answerable` is the outcome `policy_answer` reads; `found` derives `unknown`.
    [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => ({ ...OK_RESULT, outcome: 'answerable' })
  });
  const decomposer = buildDecomposer({
    tasks: [{ question: 'x', category: 'product', request_kind: 'question' }],
    needs: ['policy_answer']
  });
  const openai = buildOpenAI([{ content: caseFileAnswer() }]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm', decomposer });

  return investigate({
    ...PRODUCT_TICKET,
    policy: {
      answerSet: 'orders',
      situationKey: null,
      answers: [
        {
          answerKey: 'plain',
          situationKey: null,
          conditions: { policy_answer: ['answered'] },
          route: null,
          ask: [],
          offerCode: null,
          priority: 0,
          isFallback: false
        }
      ]
    }
  }).then((caseFile) => {
    assert.equal(caseFile.policy?.knowledge_document_id, null);
  });
});

// --- rule-directed collection ------------------------------------------------

/** P-18's shape: four rules, four signatures on one need. */
function promoPolicy(collectionMode) {
  return {
    answerSet: 'promotions',
    situationKey: 'P-18',
    collectionMode,
    answers: ['unknown', 'expired', 'active', 'not_found'].map((finding, i) => ({
      answerKey: `r${i}`,
      situationKey: 'P-18',
      conditions: { promotion_validity: [finding] },
      route: null,
      ask: [],
      offerCode: null,
      priority: 0,
      isFallback: false
    }))
  };
}

const PROMO_TICKET = {
  id: 'p1',
  subject: 'code',
  text: 'mon code BIENVENUE10 ne marche pas',
  category: 'promotions',
  request_kind: 'problem',
  level: 1
};

test('a rule_directed situation collects before the model is asked', async () => {
  const registry = buildRegistry({
    [TOOL_NAMES.EXTRACT_PROMOTION_CODES]: async () => ({ ...OK_RESULT, data: { codes: ['BIENVENUE10'] } }),
    [TOOL_NAMES.LOOKUP_CUSTOMER]: async () => OK_RESULT,
    [TOOL_NAMES.LOOKUP_PROMOTION]: async () => OK_RESULT,
    [TOOL_NAMES.LIST_ACTIVE_PROMOTIONS]: async () => OK_RESULT,
    [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => OK_RESULT
  });
  const openai = buildOpenAI([{ content: caseFileAnswer() }]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm' });

  await investigate({ ...PROMO_TICKET, policy: promoPolicy('rule_directed') });

  // The opening moves extract the code; the planner then looks the promotion up,
  // which is the call that separates the four rules — and it happens before the
  // model has spoken at all.
  const called = registry.calls.map((c) => c.name);
  assert.ok(called.includes(TOOL_NAMES.LOOKUP_PROMOTION), `planner call missing from ${called.join(',')}`);
  assert.ok(
    called.indexOf(TOOL_NAMES.LOOKUP_PROMOTION) < called.length,
    'the lookup ran'
  );
  const lookupArgs = registry.calls.find((c) => c.name === TOOL_NAMES.LOOKUP_PROMOTION).args;
  assert.deepEqual(lookupArgs, { code: 'BIENVENUE10' }, 'chained from the extracted code, not invented');
});

test('the same ticket in model mode collects nothing extra', async () => {
  // The opt-in IS the safety property: identical rules, identical evidence, and
  // the run is exactly what it is today.
  const registry = buildRegistry({
    [TOOL_NAMES.EXTRACT_PROMOTION_CODES]: async () => ({ ...OK_RESULT, data: { codes: ['BIENVENUE10'] } }),
    [TOOL_NAMES.LOOKUP_CUSTOMER]: async () => OK_RESULT,
    [TOOL_NAMES.LOOKUP_PROMOTION]: async () => OK_RESULT,
    [TOOL_NAMES.LIST_ACTIVE_PROMOTIONS]: async () => OK_RESULT,
    [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => OK_RESULT
  });
  const openai = buildOpenAI([{ content: caseFileAnswer() }]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm' });

  await investigate({ ...PROMO_TICKET, policy: promoPolicy('model') });

  assert.ok(!registry.calls.map((c) => c.name).includes(TOOL_NAMES.LOOKUP_PROMOTION));
});

test('the global switch overrides an opted-in situation', async () => {
  const registry = buildRegistry({
    [TOOL_NAMES.EXTRACT_PROMOTION_CODES]: async () => ({ ...OK_RESULT, data: { codes: ['X'] } }),
    [TOOL_NAMES.LOOKUP_CUSTOMER]: async () => OK_RESULT,
    [TOOL_NAMES.LOOKUP_PROMOTION]: async () => OK_RESULT,
    [TOOL_NAMES.LIST_ACTIVE_PROMOTIONS]: async () => OK_RESULT,
    [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => OK_RESULT
  });
  const openai = buildOpenAI([{ content: caseFileAnswer() }]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm', plannerEnabled: false });

  await investigate({ ...PROMO_TICKET, policy: promoPolicy('rule_directed') });

  assert.ok(!registry.calls.map((c) => c.name).includes(TOOL_NAMES.LOOKUP_PROMOTION));
});

test('a situation that never matched is never rule-directed', async () => {
  // No situation key means nothing was opted in, whatever the mode column says.
  const registry = buildRegistry({
    [TOOL_NAMES.EXTRACT_PROMOTION_CODES]: async () => ({ ...OK_RESULT, data: { codes: ['X'] } }),
    [TOOL_NAMES.LOOKUP_CUSTOMER]: async () => OK_RESULT,
    [TOOL_NAMES.LOOKUP_PROMOTION]: async () => OK_RESULT,
    [TOOL_NAMES.LIST_ACTIVE_PROMOTIONS]: async () => OK_RESULT,
    [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => OK_RESULT
  });
  const openai = buildOpenAI([{ content: caseFileAnswer() }]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm' });

  await investigate({
    ...PROMO_TICKET,
    policy: { ...promoPolicy('rule_directed'), situationKey: null }
  });

  assert.ok(!registry.calls.map((c) => c.name).includes(TOOL_NAMES.LOOKUP_PROMOTION));
});

test('the planner leaves the model a reserve it cannot spend', async () => {
  // A planner that could take the last call would starve the fallback on exactly
  // the tickets that need it — a decomposed email whose second half no rule
  // speaks to.
  const registry = buildRegistry({
    [TOOL_NAMES.EXTRACT_PROMOTION_CODES]: async () => ({ ...OK_RESULT, data: { codes: ['X'] } }),
    [TOOL_NAMES.LOOKUP_CUSTOMER]: async () => OK_RESULT,
    [TOOL_NAMES.LOOKUP_PROMOTION]: async () => OK_RESULT,
    [TOOL_NAMES.LIST_ACTIVE_PROMOTIONS]: async () => OK_RESULT,
    [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => OK_RESULT
  });
  const openai = buildOpenAI([{ content: caseFileAnswer() }]);
  // Two opening moves plus a reserve of two leaves the planner one call.
  const { investigate } = createInvestigator(openai, registry, { model: 'm', maxToolCalls: 5 });

  const caseFile = await investigate({ ...PROMO_TICKET, policy: promoPolicy('rule_directed') });

  assert.ok(caseFile.toolCalls.length <= 3, `planner overspent: ${caseFile.toolCalls.length} calls`);
});

test('a proposal the cache serves does not license another one', async () => {
  // THE HANG THIS GUARDS. `run.call` serves a repeat from cache and returns the
  // ORIGINAL entry — truthy, no new id, no new row. Read as success, the planner
  // re-derives the same findings, proposes the same need and spins forever
  // without spending budget; because every await resolves as a microtask, it
  // starves the event loop rather than merely looping. Measured before the fix:
  // the run never returned.
  //
  // The scenario is a rule branching on a need an OPENING MOVE already settled,
  // which is not exotic — it is the promotions set on any ticket.
  const registry = buildRegistry({
    [TOOL_NAMES.EXTRACT_PROMOTION_CODES]: async () => ({ ...OK_RESULT, data: { codes: ['X'] } }),
    [TOOL_NAMES.LOOKUP_CUSTOMER]: async () => OK_RESULT,
    [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => OK_RESULT
  });
  const openai = buildOpenAI([{ content: caseFileAnswer() }]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm' });

  // Every rule branches on the need the opening move already established, so the
  // only thing the planner could propose is a call that is already in the ledger.
  const policy = {
    answerSet: 'promotions',
    situationKey: 'P-18',
    collectionMode: 'rule_directed',
    answers: ['resolved', 'none', 'unknown'].map((finding, i) => ({
      answerKey: `r${i}`,
      situationKey: 'P-18',
      conditions: { promotion_identity: [finding] },
      route: null,
      ask: [],
      offerCode: null,
      priority: 0,
      isFallback: false
    }))
  };

  const caseFile = await investigate({ ...PROMO_TICKET, policy });

  const extracts = registry.calls.filter((c) => c.name === TOOL_NAMES.EXTRACT_PROMOTION_CODES);
  assert.equal(extracts.length, 1, 'the opening move ran it once and the planner did not repeat it');
  assert.ok(caseFile.verdict, 'the run returned at all, which is the actual assertion');
});

// --- suppression, which ships off --------------------------------------------

test('the rule being decided is not on its own enough to stop collecting', async () => {
  // THE MEASUREMENT THIS ENCODES: on 58 of 90 runs the rule was already decided,
  // and 50 of those still produced established facts. A reply rests on facts no
  // rule branches on, so "the rule is settled" says nothing about "the answer is
  // ready". Both conditions or neither.
  const registry = buildRegistry({
    [TOOL_NAMES.EXTRACT_PROMOTION_CODES]: async () => ({ ...OK_RESULT, data: { codes: ['X'] } }),
    [TOOL_NAMES.LOOKUP_CUSTOMER]: async () => OK_RESULT,
    [TOOL_NAMES.LOOKUP_PROMOTION]: async () => OK_RESULT,
    [TOOL_NAMES.LIST_ACTIVE_PROMOTIONS]: async () => OK_RESULT,
    [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => OK_RESULT
  });
  // One rule, so the policy is decided from the very first turn — and the
  // promotions floor still wants the code's validity established.
  const policy = {
    answerSet: 'promotions',
    situationKey: 'P-18',
    collectionMode: 'rule_directed',
    suppresses: true,
    answers: [
      {
        answerKey: 'only',
        situationKey: 'P-18',
        conditions: {},
        route: null,
        ask: [],
        offerCode: null,
        priority: 0,
        isFallback: false
      }
    ]
  };
  const openai = buildOpenAI([
    { toolCalls: [{ id: 'c1', name: TOOL_NAMES.SEARCH_KNOWLEDGE, args: {}, argsError: null }] },
    { content: caseFileAnswer() }
  ]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm' });

  await investigate({ ...PROMO_TICKET, policy });

  // The model still got its turn, because the response floor was not met.
  assert.ok(openai.sent.length > 1, 'the loop did not stop on a decided rule alone');
});

test('with the flag off the loop is exactly what it is today', async () => {
  const registry = buildRegistry({
    [TOOL_NAMES.EXTRACT_PROMOTION_CODES]: async () => ({ ...OK_RESULT, data: { codes: ['X'] } }),
    [TOOL_NAMES.LOOKUP_CUSTOMER]: async () => OK_RESULT,
    [TOOL_NAMES.LOOKUP_PROMOTION]: async () => OK_RESULT,
    [TOOL_NAMES.LIST_ACTIVE_PROMOTIONS]: async () => OK_RESULT,
    [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => OK_RESULT
  });
  const openai = buildOpenAI([
    { toolCalls: [{ id: 'c1', name: TOOL_NAMES.SEARCH_KNOWLEDGE, args: {}, argsError: null }] },
    { content: caseFileAnswer() }
  ]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm' });

  // `suppresses` absent entirely, which is how every situation ships.
  await investigate({ ...PROMO_TICKET, policy: promoPolicy('rule_directed') });

  assert.ok(openai.sent.length > 1, 'the model was asked, as it always is today');
});

// --- one email, two requests -------------------------------------------------

/** A rule set that always selects, so the test is about combining, not matching. */
function alwaysRule(answerSet, key, overrides = {}) {
  return {
    answerSet,
    situationKey: overrides.situationKey ?? null,
    answers: [
      {
        answerKey: key,
        situationKey: overrides.situationKey ?? null,
        conditions: {},
        answerSkeleton: overrides.skeleton ?? `skeleton for ${key}`,
        route: overrides.route ?? null,
        ask: overrides.ask ?? [],
        offerCode: overrides.offerCode ?? null,
        knowledgeDocumentId: null,
        tones: overrides.tones ?? [],
        priority: 0,
        isFallback: false
      }
    ]
  };
}

function twoRequestInvestigator(secondary, openaiTurns) {
  const registry = buildRegistry({
    [TOOL_NAMES.LOOKUP_PRODUCT]: async () => OK_RESULT,
    [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => OK_RESULT
  });
  const openai = buildOpenAI(openaiTurns ?? [{ content: caseFileAnswer() }]);
  return createInvestigator(openai, registry, {
    model: 'm',
    // Stands in for the runner's loader: the second family's rules, no situation.
    policyForRequest: async ({ answerSet }) => (answerSet === 'promotions' ? secondary : null)
  });
}

test('a second request gets its own rulebook, and both skeletons reach the prompt', async () => {
  // THE ANCHOR CASE. An email asking about a product AND a promotion selected a
  // products rule and nothing else, while the promotion it asked about sat
  // established in the same case file.
  const { investigate } = twoRequestInvestigator(alwaysRule('promotions', 'promo_rule'));

  const caseFile = await investigate({
    ...PRODUCT_TICKET,
    secondary_category: 'promotions',
    policy: alwaysRule('products', 'product_rule')
  });

  const policy = caseFile.policy;
  assert.equal(policy.per_request.length, 2, 'both requests selected');
  assert.deepEqual(policy.per_request.map((r) => r.answer_set), ['products', 'promotions']);
  assert.match(policy.answer_skeleton, /skeleton for product_rule/);
  assert.match(policy.answer_skeleton, /skeleton for promo_rule/, 'the promotion half is no longer silent');
});

test('the strictest route wins, so combining can only ever tighten', async () => {
  const { investigate } = twoRequestInvestigator(
    alwaysRule('promotions', 'promo_rule', { route: 'needs_human' })
  );

  const caseFile = await investigate({
    ...PRODUCT_TICKET,
    secondary_category: 'promotions',
    // This half would happily answer; the other wants a person.
    policy: alwaysRule('products', 'product_rule', { route: null })
  });

  assert.equal(caseFile.policy.route, 'needs_human');
  assert.equal(caseFile.verdict, 'needs_human', 'and the verdict followed it');
});

test('questions from both requests are asked once, together', async () => {
  const { investigate } = twoRequestInvestigator(
    alwaysRule('promotions', 'promo_rule', { route: 'needs_customer_input', ask: ['promotion_code', 'product_name'] })
  );

  const caseFile = await investigate({
    ...PRODUCT_TICKET,
    secondary_category: 'promotions',
    policy: alwaysRule('products', 'product_rule', { route: 'needs_customer_input', ask: ['product_name'] })
  });

  assert.deepEqual(caseFile.policy.ask, ['product_name', 'promotion_code'], 'unioned and deduplicated');
});

test('a single-request ticket produces exactly the object it produces today', async () => {
  // THE SAFETY PROPERTY: 79% of tickets have one family and must not move. The
  // combining branch cannot run for them, and `per_request` must not appear.
  const { investigate } = twoRequestInvestigator(alwaysRule('promotions', 'promo_rule'));

  const caseFile = await investigate({
    ...PRODUCT_TICKET,
    // No secondary subject, and one task.
    policy: alwaysRule('products', 'product_rule')
  });

  assert.equal(caseFile.policy.answer_key, 'product_rule');
  assert.ok(!('per_request' in caseFile.policy), 'no combining happened');
  assert.equal(caseFile.policy.answer_skeleton, 'skeleton for product_rule');
});

test('a second family whose rules do not load leaves the ticket as it was', async () => {
  // The loader returning nothing is the ordinary case for a family with no
  // approved rules, and it must not be an error.
  const { investigate } = twoRequestInvestigator(null);

  const caseFile = await investigate({
    ...PRODUCT_TICKET,
    secondary_category: 'promotions',
    policy: alwaysRule('products', 'product_rule')
  });

  assert.ok(!('per_request' in caseFile.policy));
  assert.equal(caseFile.policy.answer_key, 'product_rule');
});

test('a single request carries its rule’s tones, and no tone is an empty list', async () => {
  const toned = await twoRequestInvestigator(null).investigate({
    ...PRODUCT_TICKET,
    policy: alwaysRule('products', 'product_rule', { tones: ['firm'] })
  });
  assert.deepEqual(toned.policy.tones, ['firm']);

  const plain = await twoRequestInvestigator(null).investigate({
    ...PRODUCT_TICKET,
    policy: alwaysRule('products', 'product_rule')
  });
  assert.deepEqual(plain.policy.tones, []);
});

test('tones from both requests are combined, in catalogue order', async () => {
  // Each request's rule chose how its half should land, and one reply carries
  // both halves — so the tones union, as `ask` does, rather than one winning.
  const { investigate } = twoRequestInvestigator(
    alwaysRule('promotions', 'promo_rule', { tones: ['apologetic', 'understanding'] })
  );

  const caseFile = await investigate({
    ...PRODUCT_TICKET,
    secondary_category: 'promotions',
    policy: alwaysRule('products', 'product_rule', { tones: ['understanding', 'reassuring'] })
  });

  assert.deepEqual(caseFile.policy.tones, ['reassuring', 'apologetic', 'understanding']);
  assert.deepEqual(
    caseFile.policy.per_request.map((r) => r.tones),
    [['understanding', 'reassuring'], ['apologetic', 'understanding']],
    'and each request’s own choice stays readable'
  );
});

test('a loader that throws never costs the investigation', async () => {
  const registry = buildRegistry({
    [TOOL_NAMES.LOOKUP_PRODUCT]: async () => OK_RESULT,
    [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => OK_RESULT
  });
  const openai = buildOpenAI([{ content: caseFileAnswer() }]);
  const { investigate } = createInvestigator(openai, registry, {
    model: 'm',
    policyForRequest: async () => {
      throw new Error('supabase down');
    }
  });

  const caseFile = await investigate({
    ...PRODUCT_TICKET,
    secondary_category: 'promotions',
    policy: alwaysRule('products', 'product_rule')
  });

  assert.equal(caseFile.verdict, 'answerable', 'the case file survived');
  assert.equal(caseFile.policy.answer_key, 'product_rule');
});

test('a follow-up case delta sits between the message and the gathered evidence; none, no section', async () => {
  const registry = buildRegistry({
    [TOOL_NAMES.LOOKUP_PRODUCT]: async () => OK_RESULT,
    [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => ({ ...OK_RESULT, data: { chunks: [{ title: 'FAQ', text: 'x' }] } })
  });
  const openai = buildOpenAI([{ content: caseFileAnswer() }]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm' });

  await investigate({
    ...PRODUCT_TICKET,
    caseDelta: { relationship: 'continuation', established: [], toRefresh: [], invalidated: [], newFacts: ['Photo envoyée.'], answered: ['photo'], stillWaiting: [], promised: [] }
  });
  const prompt = openai.sent[0].messages[0].content;
  const at = (text) => prompt.indexOf(text);
  assert.ok(at('Message du client') < at('Dossier connu'));
  assert.ok(at('Dossier connu') < at('Éléments déjà recueillis'));
  assert.match(prompt, /Photo envoyée\./);

  const plain = buildOpenAI([{ content: caseFileAnswer() }]);
  await createInvestigator(plain, registry, { model: 'm' }).investigate(PRODUCT_TICKET);
  assert.doesNotMatch(plain.sent[0].messages[0].content, /Dossier connu/);
});

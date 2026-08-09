import assert from 'node:assert/strict';
import test from 'node:test';

import { createInvestigator } from './investigate.mjs';
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
  // Level 4, `contact`, cosmetovigilance and legal_privacy all land here.
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

test('the final turn forbids further tool calls and demands the schema', async () => {
  const registry = buildRegistry({ [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => OK_RESULT });
  const openai = buildOpenAI([{ content: caseFileAnswer() }]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm' });

  await investigate({ ...PRODUCT_TICKET, category: 'other' });

  const final = openai.sent.at(-1);
  assert.equal(final.toolChoice, 'none');
  assert.equal(final.schemaName, 'case_file');
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
  // `delivery` is out of scope. The case file must say so rather than answer the
  // product half and leave the customer's parcel question unanswered in silence.
  const registry = buildPlanningRegistry({
    [TOOL_NAMES.LOOKUP_PRODUCT]: async () => OK_RESULT,
    [TOOL_NAMES.SEARCH_KNOWLEDGE]: async () => OK_RESULT
  });
  const decomposer = buildDecomposer({
    tasks: [
      { question: 'Le masque convient-il ?', category: 'product', request_kind: 'question' },
      { question: 'Où est mon colis ?', category: 'delivery', request_kind: 'problem' }
    ]
  });
  const openai = buildOpenAI([{ content: caseFileAnswer() }]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm', decomposer });

  await investigate(PRODUCT_TICKET);

  const prompt = openai.sent[0].messages[0].content;
  assert.match(prompt, /Où est mon colis \?/);
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
    // Declared: one the run gets, one it looks for and misses, one nothing here
    // can ever supply.
    needs: ['product_identity', 'policy_answer', 'checkout_state']
  });
  const openai = buildOpenAI([{ content: caseFileAnswer() }]);
  const { investigate } = createInvestigator(openai, registry, { model: 'm', decomposer });

  const caseFile = await investigate(PRODUCT_TICKET);
  const byNeed = Object.fromEntries(caseFile.evidenceGaps.map((g) => [g.need, g.state]));

  assert.equal(byNeed.product_identity, 'satisfied');
  assert.equal(byNeed.policy_answer, 'attempted', 'searched, found nothing');
  assert.equal(byNeed.checkout_state, 'unavailable', 'no tool is wired for it');
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

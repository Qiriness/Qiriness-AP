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

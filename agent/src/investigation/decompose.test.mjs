import assert from 'node:assert/strict';
import test from 'node:test';

import { REQUEST_KINDS, TICKET_SUBJECTS } from '../../../scripts/lib/support-taxonomy.mjs';

import { DECOMPOSITION_SCHEMA, SYSTEM_PROMPT, createDecomposer } from './decompose.mjs';
import { MAX_TASKS } from './decompose-rules.mjs';

const LONG = 'Bonjour, '.repeat(60); // long enough to clear shouldDecompose

function buildOpenAI(answer) {
  const sent = [];
  return {
    sent,
    async completeJson(request) {
      sent.push(request);
      if (answer instanceof Error) throw answer;
      return answer;
    }
  };
}

test('a short single question never reaches the model', async () => {
  const openai = buildOpenAI({ tasks: [] });
  const { decompose } = createDecomposer(openai, { model: 'm' });

  const result = await decompose({ text: 'Où est ma commande ?', category: 'order', request_kind: 'question' });

  assert.equal(openai.sent.length, 0, 'no tokens spent to be told one question is one task');
  assert.equal(result.decomposed, false);
  assert.equal(result.tasks.length, 1);
});

test('a long email is split and the tasks come back routable', async () => {
  const openai = buildOpenAI({
    tasks: [
      { question: 'Le masque convient-il ?', category: 'product', request_kind: 'question' },
      { question: 'Mon code est refusé', category: 'promotions', request_kind: 'problem' }
    ],
    entities: { order_numbers: [], products: ['Masque LED'], codes: ['BIENVENUE10'] }
  });
  const { decompose } = createDecomposer(openai, { model: 'm' });

  const result = await decompose({ text: LONG, category: 'product', request_kind: 'question' });

  assert.equal(result.decomposed, true);
  assert.deepEqual(result.tasks.map((t) => t.category), ['product', 'promotions']);
  assert.deepEqual(result.entities.codes, ['BIENVENUE10']);
});

test('a failed call falls back to one task instead of failing the investigation', async () => {
  // The worst case must be the old cost, never a lost ticket.
  const openai = buildOpenAI(new Error('openai 500'));
  const { decompose } = createDecomposer(openai, { model: 'm' });

  const result = await decompose({ text: LONG, category: 'product', request_kind: 'question' });

  assert.equal(result.decomposed, false);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].category, 'product');
});

test('the same shape comes back whether the model ran or not', async () => {
  const openai = buildOpenAI({ tasks: [{ question: 'a' }] });
  const { decompose } = createDecomposer(openai, { model: 'm' });

  const ran = await decompose({ text: LONG, category: 'product', request_kind: 'question' });
  const skipped = await decompose({ text: 'court', category: 'product', request_kind: 'question' });

  assert.deepEqual(Object.keys(ran).sort(), Object.keys(skipped).sort());
  for (const result of [ran, skipped]) {
    assert.deepEqual(Object.keys(result.entities).sort(), ['codes', 'order_numbers', 'products']);
  }
});

test('a long thread is truncated before it is sent', async () => {
  const openai = buildOpenAI({ tasks: [] });
  const { decompose } = createDecomposer(openai, { model: 'm', maxBodyChars: 50 });

  await decompose({ text: 'x'.repeat(5000), category: 'product', request_kind: 'question' });

  assert.equal(openai.sent[0].user.length, 50);
});

test('the customer is never named in the prompt', async () => {
  // Same data minimisation as the categoriser: subject and body, nothing else.
  const openai = buildOpenAI({ tasks: [] });
  const { decompose } = createDecomposer(openai, { model: 'm' });

  await decompose({
    text: LONG,
    category: 'product',
    request_kind: 'question',
    requester_email: 'marie@example.com',
    requester_name: 'Marie Dupont',
    customer_id: 'cust_1'
  });

  const payload = JSON.stringify(openai.sent[0]);
  assert.doesNotMatch(payload, /marie@example\.com/i);
  assert.doesNotMatch(payload, /Dupont/);
  assert.doesNotMatch(payload, /cust_1/);
});

// --- the schema is the first guardrail ---------------------------------------

test('the schema constrains subjects and kinds to the taxonomy', () => {
  const task = DECOMPOSITION_SCHEMA.properties.tasks.items.properties;
  assert.deepEqual(task.category.enum, [...TICKET_SUBJECTS]);
  assert.deepEqual(task.request_kind.enum, [...REQUEST_KINDS]);
});

test('the schema caps the task count as well as the normaliser', () => {
  assert.equal(DECOMPOSITION_SCHEMA.properties.tasks.maxItems, MAX_TASKS);
});

test('the schema admits no entity bucket the router cannot act on', () => {
  const entities = DECOMPOSITION_SCHEMA.properties.entities;
  assert.equal(entities.additionalProperties, false);
  assert.deepEqual(Object.keys(entities.properties).sort(), ['codes', 'order_numbers', 'products']);
});

test('the prompt tells the model that one request is the normal case', () => {
  // Left to itself a model asked for sub-questions will always find some.
  assert.match(SYSTEM_PROMPT, /UNE SEULE DEMANDE EST LE CAS NORMAL/);
});

test('the prompt forbids inferring an order number from a bare figure', () => {
  // The eval set has `bare-number-is-not-an-order` and `erp-reference-not-an-order`
  // precisely because this is the extraction's commonest false positive.
  assert.match(SYSTEM_PROMPT, /Dans le doute, laisse vide/);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { backfillTurns } from './turn-backfill.mjs';

const S = '00000000-0000-4000-8000-0000000000aa';
const msg = (id, role, at, extra = {}) => ({
  id, session_id: S, role, content: extra.content ?? 'x', action: extra.action ?? null, context: extra.context ?? {},
  model: extra.model ?? null, input_tokens: extra.input ?? null, output_tokens: extra.output ?? null, created_at: at,
});
const options = { shopDomain: 'dev.myshopify.com', productIdByHandle: new Map([['serum', 'p-serum']]), now: new Date('2026-10-30T12:00:00Z') };

test('a question and its reply become one turn, with the reply trace, the latency and the products', () => {
  const rows = backfillTurns(
    [
      msg('u1', 'user', '2026-10-20T10:00:00.000Z', { action: 'find_product' }),
      msg('a1', 'assistant', '2026-10-20T10:00:03.500Z', {
        model: 'gpt-6-luna', input: 8000, output: 100,
        context: { products: ['https://shop.example/products/serum'], trace: { calls: [3000], tools: [{ name: 'search_products', found: 1 }] } },
      }),
    ],
    options
  );
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.user_message_id, 'u1');
  assert.equal(row.latency_ms, 3500);
  assert.equal(row.route, 'llm');
  assert.equal(row.intent, 'product_discovery');
  assert.deepEqual(row.product_ids, ['p-serum']);
  assert.equal(row.input_tokens, 8000);
  assert.equal(row.backfilled, true);
});

test('a question answered by nothing before the next one is a failed turn; a fresh one is not judged', () => {
  const rows = backfillTurns(
    [
      msg('u1', 'user', '2026-10-20T10:00:00Z'),
      msg('u2', 'user', '2026-10-20T10:01:00Z'),
      msg('a2', 'assistant', '2026-10-20T10:01:02Z', { model: 'm', context: { trace: { calls: [1500], tools: [] } } }),
      msg('u3', 'user', '2026-10-30T11:58:00Z'),
    ],
    options
  );
  assert.deepEqual(rows.map((r) => [r.user_message_id, r.status, r.error_code]), [
    ['u1', 'failed', 'no_reply'],
    ['u2', 'answered', null],
  ]);
});

test('turns already recorded are skipped; the answer to a repurchase opening is reordering', () => {
  const rows = backfillTurns(
    [
      msg('o', 'assistant', '2026-10-20T09:59:00Z', { context: { opening: { kind: 'repurchase' } } }),
      msg('u1', 'user', '2026-10-20T10:00:00Z'),
      msg('a1', 'assistant', '2026-10-20T10:00:01Z', { context: { trace: { calls: [], tools: [], model_skipped: 'cart_add' } } }),
      msg('u2', 'user', '2026-10-20T10:02:00Z'),
      msg('a2', 'assistant', '2026-10-20T10:02:01Z', { model: 'm', context: { trace: { calls: [900], tools: [] } } }),
    ],
    { ...options, skip: new Set(['u2']) }
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].route, 'rules');
  assert.equal(rows[0].intent, 'reordering');
});

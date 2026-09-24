import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyShopifyqlResponse, retryAt } from './shopifyql-client.mjs';

test('an answer carries its rows, its refusals and the analytics bucket', () => {
  const result = classifyShopifyqlResponse(200, {
    data: { a: { parseErrors: [], tableData: { rows: [{ sessions: '5169' }] } } },
    extensions: { shopifyqlCost: { requestedQueryCost: 6, maximumAvailable: 1000, currentlyAvailable: 994 } }
  });
  assert.deepEqual(result, {
    kind: 'answer',
    rows: [{ sessions: '5169' }],
    parseErrors: [],
    cost: { requestedQueryCost: 6, maximumAvailable: 1000, currentlyAvailable: 994 }
  });
});

test('THROTTLED is read from the error, with the reset Shopify gave (the shape measured 2026-09-24)', () => {
  const result = classifyShopifyqlResponse(200, {
    data: { a: null },
    errors: [
      {
        message: 'Rate limited. Please retry later.',
        path: ['a'],
        extensions: {
          code: 'THROTTLED',
          cost: { requestedQueryCost: 221, maximumAvailable: 1000, currentlyAvailable: 20, windowResetAt: '2026-09-24T08:22:00+00:00' }
        }
      }
    ]
  });
  assert.deepEqual(result, { kind: 'throttled', resetAt: Date.parse('2026-09-24T08:22:00Z'), requested: 221, maximum: 1000 });
});

test('429 and 5xx are a pause; other statuses and GraphQL errors are failures', () => {
  assert.equal(classifyShopifyqlResponse(429, null).kind, 'throttled');
  assert.equal(classifyShopifyqlResponse(503, null).kind, 'throttled');
  assert.deepEqual(classifyShopifyqlResponse(401, null), { kind: 'error', message: 'HTTP 401' });
  assert.equal(classifyShopifyqlResponse(200, { errors: [{ message: 'Access denied' }] }).kind, 'error');
  assert.equal(classifyShopifyqlResponse(200, { data: {} }).kind, 'error');
});

test('a retry waits for the reset, and never less than a second when the clocks disagree', () => {
  const now = Date.parse('2026-09-24T08:21:30Z');
  assert.equal(retryAt({ resetAt: Date.parse('2026-09-24T08:22:00Z') }, now), Date.parse('2026-09-24T08:22:00.500Z'));
  assert.equal(retryAt({ resetAt: now - 5000 }, now), now + 1000);
  assert.equal(retryAt({ resetAt: null }, now), now + 2000);
});

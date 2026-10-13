import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// THE STOREFRONT ADVISOR NEVER READS CUSTOMERS OR ORDERS, except through one
// narrow function: a signed-in customer's own purchase summary
// (docs/decisions/storefront-advisor.md § Purchase history: identity from the
// signature only). That reader does not exist yet (Phase 1); when it does it is
// the one file allowed below, and its output goes through toPurchaseSummary.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');

/** The only file that may name these tables. Not built yet. */
const PURCHASE_READER = 'purchase-summary-repository.mjs';

const PERSONAL_TABLES = /['"`](customers|orders|order_lines|customer_addresses)['"`]|\b(?:T|TABLES)\.(CUSTOMERS|ORDERS)\b/;

const sources = [
  ...fs.readdirSync(here).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs')).map((f) => path.join(here, f)),
  path.join(root, 'web', 'lib', 'server', 'storefront-chat-service.ts'),
  path.join(root, 'web', 'app', 'api', 'storefront', 'chat', 'route.ts'),
  path.join(root, 'web', 'app', 'api', 'storefront', 'event', 'route.ts'),
];

test('no storefront module but the purchase reader names the customer or order tables', () => {
  for (const file of sources) {
    if (path.basename(file) === PURCHASE_READER) continue;
    const match = PERSONAL_TABLES.exec(fs.readFileSync(file, 'utf8'));
    assert.equal(match, null, `${path.relative(root, file)} names ${match?.[0]}`);
  }
});

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { segmentArgs } from '../../../../scripts/lib/segment-finder.mjs';
import { vipArgs } from '../../../../scripts/lib/vip-rule.mjs';

/**
 * TWO SHOPS SHARE ONE CACHE, SO EVERY CACHED READ MUST NAME ITS SHOP.
 *
 * The Insights reads go through Vercel's shared Data Cache, keyed by their
 * arguments (insights/shared.ts, insights/shopifyql.ts). A read whose arguments
 * do not include the shop would answer Barbara Gould with Qiriness's figures, or
 * the reverse: plausible numbers, nothing failing. docs/decisions/insights.md
 * § Several shops, one dashboard.
 */

const DIR = new URL('./', import.meta.url);
const sources = readdirSync(DIR)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => ({ name, text: readFileSync(new URL(name, DIR), 'utf8') }));

/** The argument text of every call to `fn(...)`, parentheses balanced. */
function callArguments(text, fn) {
  const calls = [];
  // A type argument may nest one level: callRpc<Record<string, unknown>>(...).
  const re = new RegExp(`\\b${fn}(?:<(?:[^<>]|<[^<>]*>)*>)?\\(`, 'g');
  let match;
  while ((match = re.exec(text))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
    }
    calls.push(text.slice(re.lastIndex, i - 1));
  }
  return calls;
}

// The ways a call names its shop: directly, through the range helpers, or the
// VIP rule's arguments (vipArgsFor), the segment finder's (segmentArgs), or
// Sales' mixArgs (orderArgs plus the platform's channels): each asserted below.
const NAMES_SHOP = /p_shop|rangeArgs\(|orderArgs\(|vipArgsFor\(|segmentArgs\(shopId|mixArgs\(/;

/**
 * A call's arguments, with each variable it passes whole (`previousArgs`) or
 * spreads (`{ ...args, p_grain }`) followed to its declaration in the file.
 */
function resolvedArguments(text, args) {
  const second = args.split(',').slice(1).join(',').trim();
  const whole = second.match(/^([A-Za-z_$][\w$]*)\s*$/)?.[1];
  const spread = [...second.matchAll(/\.\.\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  const declarations = [whole, ...spread]
    .filter(Boolean)
    .map((variable) => text.match(new RegExp(`const ${variable}\\s*=\\s*([^;]+);`))?.[1] ?? '');
  return [args, ...declarations].join(' /* declared: */ ');
}

test('every cached database read in Insights passes the shop', () => {
  let checked = 0;
  for (const { name, text } of sources) {
    if (name === 'shared.ts') continue; // the definitions themselves
    for (const fn of ['callRpc', 'callRpcOne']) {
      for (const args of callArguments(text, fn)) {
        checked++;
        assert.match(resolvedArguments(text, args), NAMES_SHOP, `${name}: ${fn}(${args.replace(/\s+/g, ' ').slice(0, 120)}) names no shop`);
      }
    }
  }
  assert.ok(checked > 40, `only ${checked} calls found: the scan has stopped matching`);
});

test('the VIP rule and segment finder arguments carry the shop they are given', () => {
  assert.equal(vipArgs('shop-1', { minSpend: 80, minOrders: 1, windowMonths: 6 }, []).p_shop, 'shop-1');
  assert.equal(segmentArgs('shop-2', { windowMonths: 6, conditions: [], connectors: [] }).p_shop, 'shop-2');
});

test("Sales' mixArgs starts from orderArgs, so it carries the shop", () => {
  const text = sources.find((s) => s.name === 'sales-service.ts').text;
  assert.match(text, /function mixArgs\(ctx: InsightsContext\) \{\s*const base = orderArgs\(ctx\);/);
});

test('every Shopify Analytics query is asked on the context shop', () => {
  let checked = 0;
  for (const { name, text } of sources) {
    if (name === 'shopifyql.ts') continue;
    for (const args of callArguments(text, 'shopifyql')) {
      checked++;
      assert.match(args, /^\s*ctx\.shopDomain\s*,/, `${name}: shopifyql(${args.slice(0, 80)}) is not asked on ctx.shopDomain`);
    }
  }
  assert.ok(checked >= 10, `only ${checked} ShopifyQL calls found`);
});

test('the shared ShopifyQL cache is keyed by shop and query, never the query alone', () => {
  const text = sources.find((s) => s.name === 'shopifyql.ts').text;
  assert.match(text, /unstable_cache\(\s*\(shopDomain: string, query: string/);
  assert.doesNotMatch(text, /\["insights-shopifyql"\]/, 'the old query-only cache key is back');
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { RPC } from '../../scripts/lib/tables.mjs';

import { checkClause, codeOnly, functionsIn, read } from './_shared.test.mjs';

const SQL = read('12_vip_rule');
const ANALYTICS = read('06_analytics');
const FOUNDATION = read('01_foundation');

const vip = (sql) => functionsIn(sql).filter((name) => name.startsWith('vip_') || name === 'open_orders');

function statementOf(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  if (start < 0) return undefined;
  const end = sql.indexOf('\n$$;', start);
  return sql.slice(start, end + 4);
}

test('12 brings forward exactly the VIP functions the baseline declares', () => {
  assert.deepEqual(vip(SQL).sort(), ['open_orders', 'vip_customers', 'vip_summary', 'vip_tickets']);
  assert.deepEqual(vip(ANALYTICS).sort(), vip(SQL).sort());
});

test('12 copies each function from 06 rather than retyping it', () => {
  for (const name of vip(ANALYTICS)) {
    assert.equal(statementOf(SQL, name), statementOf(ANALYTICS, name), `${name} differs between 06 and 12`);
  }
});

test('THE RULE IS AND, AND BOTH COMPARISONS ARE STRICT', () => {
  // The owner's words: more than the spend AND more than the orders. An `or`
  // here would admit 288 customers where the rule admits 97 (measured
  // 2026-09-11 at > €300 and > 2 orders in 12 months).
  const body = codeOnly(statementOf(ANALYTICS, 'vip_customers'));
  assert.match(body, /where w\.spend > p_min_spend\s+and w\.orders > p_min_orders/);
  assert.doesNotMatch(body, /w\.spend >= |w\.orders >= /);
  assert.doesNotMatch(body, /p_min_spend\s+or\s+w\.orders/);
});

test('the other two functions go through vip_customers rather than restating the rule', () => {
  for (const name of ['vip_tickets', 'vip_summary', 'open_orders']) {
    const body = codeOnly(statementOf(ANALYTICS, name));
    assert.match(body, /public\.vip_customers\(/, `${name} does not call vip_customers`);
    assert.doesNotMatch(body, /> p_min_spend/, `${name} restates the rule`);
  }
});

test('the rule is complete or absent, the same way in the baseline and in 12', () => {
  const baseline = checkClause(FOUNDATION, 'shops_vip_rule_check');
  const forward = checkClause(SQL, 'shops_vip_rule_check');
  assert.ok(baseline && forward);
  assert.equal(forward.replace(/\s+/g, ' ').trim(), baseline.replace(/\s+/g, ' ').trim());
});

test('every VIP function is named in the contract, revoked from anon, and documented', () => {
  const contracted = new Set(Object.values(RPC));
  for (const name of vip(ANALYTICS)) {
    assert.ok(contracted.has(name), `${name} is not in RPC`);
    assert.match(ANALYTICS, new RegExp(`revoke all on function public\\.${name} from public, anon, authenticated`));
    assert.match(ANALYTICS, new RegExp(`grant execute on function public\\.${name} to service_role`));
    assert.match(ANALYTICS, new RegExp(`comment on function public\\.${name} is`));
    assert.match(statementOf(ANALYTICS, name), /set search_path = public/);
  }
});

test('12 is idempotent and sets no rule', () => {
  const code = codeOnly(SQL);
  assert.doesNotMatch(code, /create function/i);
  assert.doesNotMatch(code, /add column (?!if not exists)/i);
  // No value is chosen for anyone: an update here would be a business decision.
  assert.doesNotMatch(code, /^\s*(update|insert|delete)\s+/im);
});

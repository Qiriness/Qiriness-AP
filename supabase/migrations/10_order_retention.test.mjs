import assert from 'node:assert/strict';
import test from 'node:test';

import { RETENTION_MODES, RETENTION_REASONS } from '../../scripts/lib/order-retention.mjs';

import { checkClause, codeOnly, literalsIn, read } from './_shared.test.mjs';

const SQL = read('10_order_retention');
const FOUNDATION = read('01_foundation');
const SHOPIFY = read('02_shopify');

// --- the vocabulary, which is a copy and must not drift ----------------------

test('the rule constraint lists exactly the reasons the mapper can produce', () => {
  // A check constraint cannot import a module, so this test is the only thing
  // holding the two together -- the same arrangement as parameter kinds in 09.
  // It is also the assertion that would have caught the drift this migration
  // reconciles: the live constraint allowed `delivered_plus_6_months`, a value
  // that appears in no file in this repo.
  const clause = checkClause(SHOPIFY, 'orders_retention_rule_check');
  assert.ok(clause, 'the constraint is missing from the baseline');
  assert.deepEqual(literalsIn(clause), [...RETENTION_REASONS].sort());
});

test('the migration ends at the same vocabulary as the baseline', () => {
  // 10 ALTERs a live database into the state 02 declares. If the two lists ever
  // disagreed, a fresh install and a migrated one would refuse different rows.
  const clause = checkClause(SQL, 'orders_retention_rule_check');
  assert.ok(clause, 'the constraint is missing from the migration');
  assert.deepEqual(literalsIn(clause), [...RETENTION_REASONS].sort());
});

test('no rule name carries a duration any more', () => {
  // The property that makes the period switchable at all: a period in an enum
  // multiplies the enum with every new window.
  // Comments are stripped first: the header of 10 quotes the old names in order
  // to explain the drift it reconciles, and that prose must not fail this.
  for (const sql of [SQL, SHOPIFY]) {
    assert.ok(
      !/_plus_\d+_months/.test(codeOnly(sql)),
      'a duration-bearing rule name is back in the schema'
    );
  }
});

// --- the switch --------------------------------------------------------------

test('the mode constraint lists exactly the modes the reader knows', () => {
  const clause = checkClause(FOUNDATION, 'shops_order_retention_check');
  assert.ok(clause, 'the constraint is missing');
  for (const mode of RETENTION_MODES) {
    assert.match(clause, new RegExp(`'${mode}'`), `${mode} is unreachable`);
  }
});

test('the mode and the number cannot disagree', () => {
  // 'indefinite' with a month count would leave two readings of one setting;
  // 'months' without one would be a period the reader has to guess.
  const clause = checkClause(FOUNDATION, 'shops_order_retention_check');
  assert.match(clause, /order_retention_mode = 'months'[\s\S]*?order_retention_months is not null/);
  assert.match(clause, /order_retention_mode = 'indefinite'[\s\S]*?order_retention_months is null/);
});

test('indefinite is a word somebody typed, never an empty field', () => {
  // The reason this is not a support_parameters row: there, null means "nobody
  // has decided yet". Indefinite retention of personal data must not be
  // reachable by leaving something blank, so the mode column is NOT NULL with a
  // bounded default.
  assert.match(FOUNDATION, /order_retention_mode text not null default 'months'/);
});

// --- what the migration has to do in order -----------------------------------

test('the rule rewrite happens between dropping and adding the constraint', () => {
  // BOTH HALVES, because getting one right is not enough and the first attempt
  // at this migration proved it. It ran the update before the drop and Postgres
  // rejected the whole thing: `new row for relation "orders" violates check
  // constraint "orders_retention_rule_check"` -- the OLD constraint allowed only
  // the duration-bearing names, so writing 'delivered' broke it. The NEW one
  // allows only the reason names, so it cannot precede the update either. The
  // rewrite has to sit in the gap where neither is in force.
  const drop = SQL.indexOf('drop constraint if exists orders_retention_rule_check');
  const update = SQL.indexOf('update public.orders\n   set retention_rule');
  const addConstraint = SQL.indexOf('add constraint orders_retention_rule_check');

  assert.ok(drop > -1, 'the old constraint is never dropped');
  assert.ok(update > -1, 'the data migration is missing');
  assert.ok(addConstraint > -1, 'the new constraint is never added');

  assert.ok(drop < update, 'the old constraint must be dropped before the rewrite');
  assert.ok(update < addConstraint, 'the new constraint must be added after the rewrite');
});

test('both the repo vocabulary and the drifted live one are mapped', () => {
  // The live database held `delivered_plus_6_months` while this repo emitted
  // `delivered_plus_3_months`. Prefix matching covers both, so this applies
  // cleanly whichever one a database happens to hold.
  for (const prefix of ['delivered%', 'undelivered%', 'return_refund_completed%', 'return_refund_open%']) {
    assert.ok(SQL.includes(`like '${prefix}'`), `${prefix} is not mapped`);
  }
});

test('the shop is set to indefinite and its delete dates are cleared', () => {
  // Clearing the dates is what actually stops the next sync deleting rows that
  // were stamped under the old policy -- 161 were already past their date.
  assert.match(SQL, /set order_retention_mode = 'indefinite'/);
  assert.match(SQL, /set retention_delete_after = null/);
});

test('every statement is idempotent, so it applies to a fresh baseline too', () => {
  // 01 and 02 already declare the end state; on a new install this must be a
  // no-op rather than an error.
  for (const statement of SQL.matchAll(/alter table public\.\w+\s+add column (?!if not exists)/g)) {
    assert.fail(`add column without "if not exists": ${statement[0]}`);
  }
  for (const name of ['shops_order_retention_check', 'orders_retention_rule_check']) {
    assert.ok(
      SQL.includes(`drop constraint if exists ${name}`),
      `${name} is added without being dropped first`
    );
  }
});

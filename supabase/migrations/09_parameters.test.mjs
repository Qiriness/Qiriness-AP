import assert from 'node:assert/strict';
import test from 'node:test';

import { PARAMETER_KINDS } from '../../scripts/lib/parameters.mjs';

import { checkClause, literalsIn, read, tablesIn } from './_shared.test.mjs';

const SQL = read('09_parameters');

test('it creates the parameter table, and nothing else', () => {
  assert.deepEqual(tablesIn(SQL), ['support_parameters']);
});

// --- the vocabulary, which is a copy and must not drift ----------------------

test('kind accepts exactly the kinds the reader can parse', () => {
  // `parameters.mjs` switches on this to decide how to read a value. A kind the
  // constraint allows and the reader does not know would store a value nothing
  // can turn into a number; a kind the reader knows and the constraint refuses
  // would be unreachable. A check constraint cannot import a module, so this
  // test is the only thing holding the two lists together — same arrangement as
  // requirement_needs in 05.
  const clause = checkClause(SQL, 'support_parameters_kind_check');
  assert.ok(clause, 'the constraint is missing');
  assert.deepEqual(literalsIn(clause), [...PARAMETER_KINDS].sort());
});

// --- what the table refuses --------------------------------------------------

test('a days value must be a whole number, an amount a decimal', () => {
  // The property every reader depends on: a `days` parameter can always be
  // compared against a date without anyone checking first.
  const clause = checkClause(SQL, 'support_parameters_value_shape_check');
  assert.ok(clause, 'the constraint is missing');
  assert.match(clause, /kind = 'days' and value ~ '\^\[0-9\]\+\$'/);
  assert.match(clause, /kind = 'amount'/);
});

test('a null value is allowed, and is the state every parameter starts in', () => {
  // NOT AN OVERSIGHT. The numbers are the merchant's, and this shop's two
  // approved articles disagree about the returns window — seeding a guess would
  // put a third answer into circulation wearing the authority of a setting.
  const clause = checkClause(SQL, 'support_parameters_value_shape_check');
  assert.match(clause, /value is null/);
  assert.ok(!/value text not null/.test(SQL), 'the column must stay nullable');
});

test('a key is lower snake case, because it is compared literally', () => {
  const clause = checkClause(SQL, 'support_parameters_key_shape_check');
  assert.ok(clause, 'the constraint is missing');
  assert.match(clause, /\^\[a-z\]\[a-z0-9_\]\*\$/);
});

test('one row per key per shop, so a re-save updates rather than duplicates', () => {
  assert.match(
    SQL,
    /create unique index support_parameters_shop_key_unique[\s\S]*?\(shop_id, parameter_key\)/,
  );
});

test('it is scoped to a shop and cascades with it', () => {
  assert.match(SQL, /shop_id uuid not null\s+references public\.shops\(id\) on delete cascade/);
});

test('row level security is enabled, like every other table here', () => {
  assert.match(SQL, /alter table public\.support_parameters enable row level security/);
});

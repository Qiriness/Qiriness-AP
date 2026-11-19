import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSaleArgs } from './sale-prices.mjs';

test('preview/apply need a collection and a whole percent', () => {
  const args = parseSaleArgs(['apply', '--collection', 'black-friday', '--percent', '20']);
  assert.equal(args.command, 'apply');
  assert.equal(args.collection, 'black-friday');
  assert.equal(args.percent, 20);
  assert.equal(args.includeDrafts, false);

  assert.equal(parseSaleArgs(['preview', '--collection=bf', '--percent=15', '--include-drafts']).includeDrafts, true);
  assert.throws(() => parseSaleArgs(['apply', '--percent', '20']), /--collection/);
  assert.throws(() => parseSaleArgs(['apply', '--collection', 'bf']), /--percent/);
  assert.throws(() => parseSaleArgs(['apply', '--collection', 'bf', '--percent', '95']), /--percent/);
});

test('restore needs exactly one of --collection or --all', () => {
  assert.equal(parseSaleArgs(['restore', '--all']).all, true);
  assert.equal(parseSaleArgs(['restore', '--collection', 'bf', '--force']).force, true);
  assert.throws(() => parseSaleArgs(['restore']), /exactly one/);
  assert.throws(() => parseSaleArgs(['restore', '--all', '--collection', 'bf']), /exactly one/);
});

test('unknown commands and options are refused, not ignored', () => {
  assert.throws(() => parseSaleArgs(['apply-all']), /First argument/);
  assert.throws(() => parseSaleArgs(['status', '--dry-run']), /Unknown option/);
  assert.equal(parseSaleArgs(['status']).command, 'status');
});

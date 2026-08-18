import assert from 'node:assert/strict';
import test from 'node:test';

import { USAGE_PASSES } from '../../agent/src/llm/usage-sink.mjs';

import { checkClause, literalsIn, read } from './_shared.test.mjs';

const SQL = read('06_analytics');

test('the cost ledger accepts exactly the passes the sink can emit', () => {
  // TWO COPIES OF ONE LIST, and this is what stops them drifting. The sink
  // validates `pass` before a BULK insert — one unrecognised value would take
  // the whole batch's cost history down with it — so a pass added to the
  // constraint and not to USAGE_PASSES is silently recorded as 'other', and one
  // added to USAGE_PASSES and not to the constraint fails the insert for every
  // row in the flush. A check constraint cannot import a module; this can.
  assert.deepEqual(
    literalsIn(checkClause(SQL, 'llm_usage_pass_check')),
    [...USAGE_PASSES].sort()
  );
});

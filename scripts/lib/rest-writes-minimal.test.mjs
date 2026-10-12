import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * A write whose result nobody reads asks for no row back.
 *
 * WHY. The REST write helpers default to `return=representation`: PostgREST sends
 * every written row back. On a statement like `await supabaseUpdateById(...);`
 * that response is discarded, and it is pure egress — the full ticket row on
 * ~15.6k writes a day was the largest single egress statement (2026-10-12).
 * Every such call passes `{ returning: 'minimal' }`; this keeps new ones honest.
 *
 * What counts as discarded: the call is the whole statement — `await` before it
 * on its line, and `;` or `.catch(...)` after it. A call whose value is assigned,
 * returned or passed on is not checked: it may need the rows.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FN = /\b(supabaseInsert|supabaseUpsert|supabaseUpdate|supabaseUpdateById|supabaseDelete)\(/g;

function discardedWritesWithoutMinimal() {
  const files = execSync('git ls-files agent scripts web storefront-app', { cwd: ROOT }).toString().trim().split('\n')
    .filter((f) => /\.(mjs|js|ts|tsx)$/.test(f) && !/\.test\.|supabase-rest-client\.mjs$/.test(f));
  const offenders = [];
  for (const file of files) {
    const src = readFileSync(`${ROOT}${file}`, 'utf8');
    let m;
    FN.lastIndex = 0;
    while ((m = FN.exec(src))) {
      let depth = 0, end = m.index + m[0].length - 1;
      for (; end < src.length; end++) {
        if (src[end] === '(') depth++;
        else if (src[end] === ')' && --depth === 0) break;
      }
      const prefix = src.slice(src.lastIndexOf('\n', m.index) + 1, m.index).trim();
      const after = src.slice(end + 1, end + 12).trimStart();
      const discarded = prefix === 'await' && (after.startsWith(';') || after.startsWith('.catch('));
      if (discarded && !/returning:\s*['"]minimal['"]/.test(src.slice(m.index, end + 1))) {
        offenders.push(`${file}:${src.slice(0, m.index).split('\n').length} ${m[1]}`);
      }
    }
  }
  return offenders;
}

test('every REST write whose result is discarded asks for no row back', () => {
  assert.deepEqual(discardedWritesWithoutMinimal(), []);
});

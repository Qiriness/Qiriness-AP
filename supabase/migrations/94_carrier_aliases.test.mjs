import assert from 'node:assert/strict';
import test from 'node:test';

import { codeOnly, read } from './_shared.test.mjs';

const CODE = codeOnly(read('94_carrier_aliases'));
const FUNCTION = CODE.slice(CODE.indexOf('create or replace function public.normalise_carrier'));

/** The seed as [pattern, canonical, position] rows. */
const SEED = [...CODE.matchAll(/\('([^']+)', '([^']+)', (\d+)\)/g)].map((m) => [m[1], m[2], Number(m[3])]);

/** The function's logic, in JS, over the seed: first alias by position whose pattern the name contains. */
function normalise(value, aliases = SEED) {
  if (value === null || String(value).trim() === '') return null;
  const hit = [...aliases].sort((a, b) => a[2] - b[2] || a[0].localeCompare(b[0]))
    .find(([pattern]) => String(value).toUpperCase().includes(pattern.toUpperCase()));
  return hit ? hit[1] : String(value).trim().toUpperCase();
}

test('the seed is exactly the CASE it replaces, in the same order', () => {
  assert.deepEqual(SEED, [
    ['COLISSIMO', 'COLISSIMO', 10],
    ['LA POSTE', 'COLISSIMO', 20],
    ['GLS', 'GLS', 30],
    ['CHRONOPOST', 'CHRONOPOST', 40],
    ['MONDIAL', 'MONDIAL RELAY', 50],
    ['DHL', 'DHL', 60],
    ['UPS', 'UPS', 70]
  ]);
  assert.match(CODE, /on conflict \(pattern\) do nothing;/);
});

test('every carrier name in production (2026-10-12) folds as it did before', () => {
  const before = {
    Autre: 'AUTRE', Chronopost: 'CHRONOPOST', Colissimo: 'COLISSIMO', COLISSIMO: 'COLISSIMO',
    'La Poste Colissimo': 'COLISSIMO', 'DHL Express': 'DHL', DPD: 'DPD', FedEx: 'FEDEX',
    GLS: 'GLS', 'GLS France': 'GLS', Other: 'OTHER'
  };
  for (const [raw, expected] of Object.entries(before)) assert.equal(normalise(raw), expected, raw);
  assert.equal(normalise(null), null);
  assert.equal(normalise('   '), null);
});

test('the function reads the table, matches literally, and names no carrier', () => {
  assert.match(FUNCTION, /from public\.carrier_aliases a\s+where strpos\(upper\(value\), upper\(a\.pattern\)\) > 0\s+order by a\.position, a\.pattern\s+limit 1/);
  assert.doesNotMatch(FUNCTION, /COLISSIMO|CHRONOPOST|LA POSTE|MONDIAL|\bDHL\b|\bUPS\b|\bGLS\b/);
  assert.doesNotMatch(FUNCTION, /\blike\b/i);
});

test('security definer is safe here: one text in, one text out, pinned search_path, chat role keeps execute', () => {
  assert.match(FUNCTION, /normalise_carrier\(value text\)\s+returns text\s+language sql\s+stable\s+security definer\s+set search_path = public, pg_temp/);
  assert.match(CODE, /revoke all on function public\.normalise_carrier\(text\) from public, anon, authenticated;/);
  assert.match(CODE, /grant execute on function public\.normalise_carrier\(text\) to mgmt_chat_ro;/);
  assert.match(CODE, /alter table public\.carrier_aliases enable row level security;/);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildFresh } from '../../scripts/check-baseline.mjs';

const seed = (name) => readFileSync(new URL(`./${name}.sql`, import.meta.url), 'utf8');

test('the seeds apply to a fresh database once a shop exists, and re-running them changes nothing', async () => {
  const db = await buildFresh();
  try {
    await db.query(`insert into public.shops (shop_domain) values ('seed.test')`);
    const count = async () => (await db.query(`select
      (select count(*) from public.issue_family_members)::int as members,
      (select count(*) from public.issue_family_transitions)::int as transitions,
      (select count(*) from public.carrier_aliases)::int as aliases`)).rows[0];

    for (const name of ['issue_families', 'carrier_aliases']) await db.exec(seed(name));
    const first = await count();
    assert.ok(first.members > 0 && first.transitions > 0, 'issue families seeded for the shop');
    assert.equal(first.aliases, 7);

    for (const name of ['issue_families', 'carrier_aliases']) await db.exec(seed(name));
    assert.deepEqual(await count(), first);

    // A second shop gets its own set from the same seed.
    await db.query(`insert into public.shops (shop_domain) values ('second.test')`);
    await db.exec(seed('issue_families'));
    assert.equal((await count()).members, first.members * 2);
  } finally {
    await db.close();
  }
});

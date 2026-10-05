import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PolicyConflictError,
  createCompanyPolicyRecord,
  policiesFor,
  policyCatalogue,
  policyProblems,
  renderPolicy
} from './company-policies.mjs';
import { toParameterMap } from './parameters.mjs';
import { T } from './tables.mjs';

const TIME = { id: 'p1', policy_key: 'delivery_time_policy', name: 'Délais de livraison', purpose: 'combien de temps', content: 'Expédié sous {dispatch_days} jours ouvrés.', active: true, version: 2 };
const PLACE = { id: 'p2', policy_key: 'delivery_location_policy', name: 'Pays livrés', purpose: 'où nous livrons', content: 'France, Belgique.', active: true, version: 1 };
const OLD = { id: 'p3', policy_key: 'old_policy', name: 'Ancienne', purpose: '', content: 'x', active: false, version: 1 };
const LIBRARY = {
  policies: [TIME, PLACE, OLD],
  links: [
    { id: 'l1', policy_id: 'p1', situation_key: 'D-07', answer_id: null },
    { id: 'l2', policy_id: 'p2', situation_key: null, answer_id: 'a-33' },
    { id: 'l3', policy_id: 'p1', situation_key: null, answer_id: 'a-33' },
    { id: 'l4', policy_id: 'p3', situation_key: 'D-07', answer_id: null }
  ]
};

test("a situation's policies come first, a rule's are added, each once, inactive ones never", () => {
  const got = policiesFor(LIBRARY, { situationKey: 'D-07', answerIds: ['a-33'] });
  assert.deepEqual(got.map((g) => [g.policy.policy_key, g.source]), [
    ['delivery_time_policy', 'situation'],
    ['delivery_location_policy', 'rule']
  ]);
  assert.deepEqual(policiesFor(LIBRARY, { situationKey: 'D-99' }), []);
});

test('a policy is read with its parameters filled, and an unset one stays visible', () => {
  assert.equal(renderPolicy(TIME, toParameterMap([{ parameter_key: 'dispatch_days', value: '2' }])).text, 'Expédié sous 2 jours ouvrés.');
  const unset = renderPolicy(TIME, new Map());
  assert.equal(unset.text, TIME.content);
  assert.deepEqual(unset.unset, ['dispatch_days']);
});

test('the catalogue the model sees lists active policies with their purpose', () => {
  assert.equal(
    policyCatalogue(LIBRARY.policies),
    '- delivery_time_policy — Délais de livraison : combien de temps\n- delivery_location_policy — Pays livrés : où nous livrons'
  );
});

test('a policy that could never be read correctly is refused on save', () => {
  assert.deepEqual(policyProblems({ key: 'Delivery Time', name: '', content: '' }, { isNew: true }), ['bad_key', 'no_name', 'no_content']);
  assert.deepEqual(policyProblems({ key: 'ok', name: 'n', content: 'Sous {not_a_parameter} jours' }), ['unknown_parameter:not_a_parameter']);
  assert.deepEqual(policyProblems({ key: 'ok', name: 'n', content: 'Sous {dispatch_days} jours' }), []);
});

function recorder({ current = TIME, updated = null, insertError = null, existingLink = { id: 'l-existing' } } = {}) {
  const calls = [];
  return {
    calls,
    transport: {
      async select(_c, table, filters) {
        calls.push({ kind: 'select', table, filters });
        if (table === T.COMPANY_POLICIES) return current ? [current] : [];
        return existingLink ? [existingLink] : [];
      },
      async insert(_c, table, rows) {
        calls.push({ kind: 'insert', table, rows });
        if (insertError && table === T.COMPANY_POLICY_LINKS) throw insertError;
        return rows.map((r) => ({ id: 'new', ...r }));
      },
      async update(_c, table, filters, patch) {
        calls.push({ kind: 'update', table, filters, patch });
        return updated ?? [{ ...current, ...patch }];
      },
      async remove(_c, table, filters) {
        calls.push({ kind: 'remove', table, filters });
        return [{ id: filters.id }];
      }
    }
  };
}

test('changing the text raises the version and keeps the new text; a rename does not', async () => {
  const rec = recorder();
  const record = createCompanyPolicyRecord({}, { shopId: 's', transport: rec.transport });
  const saved = await record.save('delivery_time_policy', { content: 'Nouveau texte' }, { expectedVersion: 2, by: 'u1' });
  assert.equal(saved.version, 3);
  const update = rec.calls.find((c) => c.kind === 'update');
  assert.deepEqual(update.filters, { id: 'p1', shop_id: 's', version: 2 });
  const version = rec.calls.find((c) => c.kind === 'insert' && c.table === T.COMPANY_POLICY_VERSIONS);
  assert.deepEqual(version.rows[0], { shop_id: 's', policy_id: 'p1', version: 3, content: 'Nouveau texte', saved_by: 'u1' });

  const rename = recorder();
  await createCompanyPolicyRecord({}, { shopId: 's', transport: rename.transport }).save('delivery_time_policy', { name: 'Délais' }, {});
  assert.equal(rename.calls.find((c) => c.kind === 'update').patch.version, 2);
  assert.equal(rename.calls.filter((c) => c.kind === 'insert').length, 0);
});

test('two people saving at once: the second is refused, not overwritten', async () => {
  const stale = createCompanyPolicyRecord({}, { shopId: 's', transport: recorder().transport });
  await assert.rejects(stale.save('delivery_time_policy', { content: 'x' }, { expectedVersion: 1 }), PolicyConflictError);
  const raced = createCompanyPolicyRecord({}, { shopId: 's', transport: recorder({ updated: [] }).transport });
  await assert.rejects(raced.save('delivery_time_policy', { content: 'x' }, {}), PolicyConflictError);
});

test('linking twice is a no-op, and a link names exactly one target', async () => {
  const rec = recorder({ insertError: new Error('duplicate key value violates unique constraint "company_policy_links_situation_unique"') });
  const record = createCompanyPolicyRecord({}, { shopId: 's', transport: rec.transport });
  assert.deepEqual(await record.link('p1', { situationKey: 'D-07' }), { created: false, link: { id: 'l-existing' } });
  await assert.rejects(record.link('p1', {}), /exactly one/);
  await assert.rejects(record.link('p1', { situationKey: 'D-07', answerId: 'a' }), /exactly one/);
});

test('a new policy starts at version 1 with its first version row', async () => {
  const rec = recorder({ current: null });
  const record = createCompanyPolicyRecord({}, { shopId: 's', transport: rec.transport });
  await record.create({ key: 'refund_policy', name: ' Remboursements ', content: 'Texte' }, { by: 'u1' });
  const [policy, version] = rec.calls.filter((c) => c.kind === 'insert');
  assert.equal(policy.rows[0].version, 1);
  assert.equal(policy.rows[0].name, 'Remboursements');
  assert.deepEqual(version.rows[0], { shop_id: 's', policy_id: 'new', version: 1, content: 'Texte', saved_by: 'u1' });
});

test('the drafting instruction keeps a policy\'s possibilities possible', async () => {
  const { POLICY_INSTRUCTION } = await import('./company-policies.mjs');
  assert.match(POLICY_INSTRUCTION, /comme une possibilité, jamais comme une certitude/);
});

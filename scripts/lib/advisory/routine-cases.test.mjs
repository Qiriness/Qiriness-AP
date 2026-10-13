import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { FUNCTIONAL_TYPES, TEMPLATE_KEYS, knowledgeIndex, parseKnowledgeRows } from './product-knowledge.mjs';
import { ROUTINE_CASES } from './routine-cases.mjs';

// The invented routines bench stays consistent: every step of every foundation
// can be filled by a product of its type targeting its concerns, and every case
// asks for things that exist. The ENGINE'S score is not a test here: it is
// `npm run advisor:score`, and its failures are the work to do.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const ROUTINES = read('data/advisor/sample-routines/routines.json');
const CATALOGUE = read('data/advisor/sample-routines/catalogue.json');
const SHEET = read('data/advisor/sample-routines/knowledge.json');
const parsed = parseKnowledgeRows(SHEET.rows, { concerns: SHEET.concerns });
const KNOWLEDGE = knowledgeIndex(parsed.products);
const TYPES = new Set(Object.values(FUNCTIONAL_TYPES));
const advisable = parsed.products.filter((k) => k.status !== 'do_not_advise' && CATALOGUE.products.find((p) => p.handle === k.handle)?.inStock);

test('every product imports, with every column of the template', () => {
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.products.length, CATALOGUE.products.length);
  for (const row of SHEET.rows) assert.deepEqual(Object.keys(row), TEMPLATE_KEYS, row.handle);
});

test('every required step of every foundation has a product of its type targeting the foundation\'s concerns', () => {
  for (const f of ROUTINES.foundations) {
    for (const step of f.steps.filter((s) => s.required)) {
      assert.ok(TYPES.has(step.type), `${f.key} step type ${step.type}`);
      const fits = advisable.filter((k) => k.functional_type === step.type && (!f.primary_concerns.length || [k.primary_concern, ...k.other_concerns].some((c) => f.primary_concerns.includes(c)) || step.type === 'cleanser'));
      assert.ok(fits.length, `foundation ${f.key}: no ${step.type} for ${f.primary_concerns.join(', ') || 'a basic routine'}`);
    }
  }
});

test('the modules, the men\'s range and the treats have products', () => {
  for (const type of ['eye', 'spf']) assert.ok(advisable.some((k) => k.functional_type === type), type);
  assert.ok(advisable.some((k) => k.men && k.functional_type === 'cream') && advisable.some((k) => k.men && k.functional_type === 'cleanser'));
  assert.ok(advisable.some((k) => k.treat && CATALOGUE.products.find((p) => p.handle === k.handle).priceFrom <= ROUTINES.treats.max_price));
  for (const r of ROUTINES.treats.treat_routines) assert.ok(KNOWLEDGE.get(r.kit)?.functional_type === 'kit', r.kit);
});

test('the cases: unique ids, French and English, expectations that name real types and products', () => {
  const ids = ROUTINE_CASES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const base of new Set(ids.map((id) => id.replace(/\.(fr|en)$/, '')))) {
    assert.ok(ids.includes(`${base}.fr`) && ids.includes(`${base}.en`), base);
  }
  for (const c of ROUTINE_CASES) {
    const e = c.expect;
    for (const t of [...(e.types ?? []), ...(e.no_types ?? []), ...(e.targets ?? []).map((x) => x.type)]) assert.ok(TYPES.has(t), `${c.id}: ${t}`);
    for (const h of [...(e.no_handles ?? []), ...(c.owned ?? []), ...(c.previous ? [c.previous] : [])]) assert.ok(CATALOGUE.products.some((p) => p.handle === h), `${c.id}: ${h}`);
    for (const k of (e.targets ?? []).flatMap((x) => x.any)) assert.ok(SHEET.concerns.some((x) => x.key === k), `${c.id}: concern ${k}`);
  }
});

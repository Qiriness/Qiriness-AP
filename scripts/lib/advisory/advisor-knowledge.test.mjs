import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildAdvisorKnowledge, knowledgeRow, loadAdvisorKnowledge } from './advisor-knowledge.mjs';
import { assembleRoutines } from './assemble-routines.mjs';
import { createAdvisor } from './recommend.mjs';

// The spreadsheet made live (owner, 2026-10-16): Qiriness's real transcription
// and routine settings, assembled into what the foundation engine runs.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const SHEET = read('data/advisor/qiriness-knowledge.json');
const SETTINGS = read('data/advisor/qiriness-routine-settings.json');
const built = buildAdvisorKnowledge({ sheet: SHEET, settings: SETTINGS });
const F = (key) => built.routines.foundations.find((f) => f.key === key);

test('Qiriness: the sheet and the settings assemble with no error, and only the one known warning', () => {
  assert.deepEqual(built.errors, []);
  assert.deepEqual(built.warnings, ['foundation B: range « Soin Bonne Mine + Patch + Exfoliant » is on no product']);
  assert.equal(built.routines.foundations.length, 8);
  assert.deepEqual(built.routines.eye_concerns, ['dark_circles', 'puffiness', 'eye_wrinkles']);
});

test('the steps that must treat the concern come from the settings; the order and the required flags from the sheet', () => {
  assert.deepEqual(F('B').steps.filter((s) => s.targets === 'primary').map((s) => s.type), ['cleanser', 'lotion']);
  assert.deepEqual(F('E').steps.map((s) => [s.type, s.required]), [['cleanser', true], ['serum', true], ['cream', true], ['lotion', false], ['exfoliant', false], ['mask', false]]);
  assert.equal(F('C').tolerance_first, true);
  assert.equal(F('H').only_on_explicit_request, true);
  assert.deepEqual(F('A').skin_types, { dry: 'dryness' });
});

test('a range is matched as the products spell it: « Source d\'Eau », « Éclat Parfait », « Active Energie »', () => {
  assert.equal(F('A').preferred_range, 'Source d’Eau');
  assert.equal(F('D').preferred_range, 'Eclat Parfait');
  assert.equal(F('F').preferred_range, 'Active Énergie');
  assert.equal(F('E').premium_variant, 'Exception');
});

test('the SPF module takes its concerns from the settings, the sheet having them only in a note', () => {
  assert.deepEqual(built.routines.modules.find((m) => m.type === 'spf').when, ['dark_spots', 'uneven_tone']);
});

test('a setting that names nothing in the sheet is said, never guessed', () => {
  const { warnings } = assembleRoutines({
    routines: { foundations: [{ key: 'A', name_fr: 'A', name_en: 'A', primary_concerns: ['dryness'], preferred_ranges: [], steps: [{ order: 1, type: 'cream', frequency: 'daily', required: true }] }], modules: [] },
    rules: { concerns: [{ key: 'dryness' }], skin_type_texture: {} },
    products: [],
    settings: { foundations: { A: { targets: ['serum'] }, Z: {} }, concern_map: { dry: 'dryness', odd: 'unknown' }, foundation_priority: ['A', 'Q'] },
  });
  assert.deepEqual(warnings.sort(), [
    'concern_map: « odd » → « unknown », not a standard concern',
    'foundation A: target « serum » is not one of its steps',
    'foundation_priority: Q is not a foundation',
    'settings: foundation Z is not on the Routines tab',
  ]);
});

test('stored and read back, the engine runs on it: the foundations, not the playbooks', async () => {
  const row = knowledgeRow({ shopId: 's', version: 3, source: 'qiriness-knowledge.json', products: built.products, routines: built.routines });
  assert.equal(row.status, 'active');
  // Through JSON, as the database returns it.
  const stored = JSON.parse(JSON.stringify(row));
  const db = { selectAll: async (table, filters) => (table === 'advisor_knowledge' && filters.shop_id === 's' && filters.status === 'active' ? [stored] : []) };
  const loaded = await loadAdvisorKnowledge(db, 's');
  assert.equal(loaded.version, 3);
  assert.equal(loaded.knowledge.get('creme-nuit-anti-age-caresse-temps-sublime').functional_type, 'cream');
  const catalogue = { products: [{ id: 'p1', handle: 'creme-nuit-anti-age-caresse-temps-sublime', name: 'Crème Nuit', inStock: true, priceFrom: 68.95, variants: [], collections: [], tags: [] }], collections: [] };
  assert.equal(createAdvisor(read('data/advisor/qiriness.json'), catalogue, { knowledge: loaded.knowledge, routines: loaded.routines }).engine, 'foundations');
  assert.equal(await loadAdvisorKnowledge({ selectAll: async () => [] }, 's'), null, 'no active version: the playbooks run');
});

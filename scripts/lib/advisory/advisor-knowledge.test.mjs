import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildAdvisorKnowledge, knowledgeRow, loadAdvisorKnowledge } from './advisor-knowledge.mjs';
import { assembleRoutines } from './assemble-routines.mjs';
import { createAdvisor } from './recommend.mjs';

// The spreadsheet made live (owner, 2026-10-16): Qiriness's real transcription
// and routine settings, assembled into what the engine runs.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const SHEET = read('data/advisor/qiriness-knowledge.json');
const SETTINGS = read('data/advisor/qiriness-routine-settings.json');
const built = buildAdvisorKnowledge({ sheet: SHEET, settings: SETTINGS });
const F = (key) => built.routines.foundations.find((f) => f.key === key);

test('Qiriness: the sheet and the settings assemble with no error and no warning', () => {
  assert.deepEqual(built.errors, []);
  assert.deepEqual(built.warnings, []);
  // Sensitive skin (C), oily skin (G) and the basic routine (H) are gone: skin types now (owner, 2026-10-16).
  // Y: the eye routine (owner, 2026-10-17).
  assert.deepEqual(built.routines.foundations.map((f) => f.key), ['A', 'B', 'D', 'E', 'F', 'Y']);
  assert.deepEqual(built.routines.eye_concerns, ['dark_circles', 'puffiness', 'eye_wrinkles']);
  assert.deepEqual(built.routines.sensitive_concerns, ['redness', 'discomfort', 'reactivity']);
});

test('the day and night routines: four steps each, chosen by the criteria of the Routines tab', () => {
  const { day, night } = built.routines.routine_steps;
  assert.deepEqual(day.map((s) => [s.types, s.area]), [[['lotion', 'cleanser'], 'face'], [['serum'], 'face'], [['serum', 'cream'], 'eyes'], [['cream'], 'face']]);
  assert.deepEqual(night.map((s) => [s.types, s.area]), [[['makeup_remover'], 'face'], [['lotion'], 'face'], [['serum', 'cream'], 'eyes'], [['cream'], 'face']]);
  assert.deepEqual(day[0].chosen_by, ['skin', 'concern']);
  assert.deepEqual(day.map((s) => s.concern_required), [false, true, false, false]);
  assert.deepEqual(night[3].chosen_by, ['range', 'concern', 'time', 'skin']);
});

test('the main concerns: their range as the products spell it, by age for anti-age; the oily and sensitive concerns rehomed', () => {
  assert.equal(F('A').preferred_range, 'Source d’Eau');
  assert.equal(F('D').preferred_range, 'Eclat Parfait');
  // The owner gave Imperfections a range on 2026-10-17 (Rules tab).
  assert.equal(F('B').preferred_range, 'Eclat Parfait');
  assert.equal(F('E').range_by_age, true);
  assert.deepEqual(F('B').primary_concerns, ['blemishes', 'enlarged_pores', 'excess_sebum', 'uneven_texture', 'uneven_tone']);
  assert.deepEqual(built.routines.age_ranges.map((a) => [a.key, a.range]), [['under_25', 'Active Énergie'], ['25_34', 'Temps Sublime'], ['35_44', 'Temps Sublime'], ['45_plus', 'Exception']]);
  assert.deepEqual(built.routines.routine_times.map((t) => [t.key, t.label_fr, t.label_en]), [['day', 'Routine du jour', 'Day routine'], ['night', 'Routine de nuit', 'Night routine'], ['both', 'Jour et nuit', 'Day and night']]);
});

test('the eye routine (Y): its own day and night steps, each a fixed product but the cream, which falls back on the standard one', () => {
  const y = F('Y');
  assert.equal(y.area, 'eyes');
  assert.equal(y.sensitive, true);
  assert.equal(y.range_by_age, true);
  assert.deepEqual(y.primary_concerns, ['dark_circles', 'puffiness', 'eye_wrinkles']);
  assert.deepEqual(y.questions, ['concern', 'eye_concern', 'age', 'routine_time']);
  const { day, night } = y.routine_steps;
  assert.deepEqual(day.map((s) => s.product), ['lotion-tonique-hydratante-eclat-parfait', 'patchs-yeux-clat-anti-age-regard-or-60-patchs', 'serum-anti-age-elixir-regard-eclat', 'contour-des-yeux-caresse-regard-energie']);
  assert.deepEqual(night.map((s) => s.product), ['demaquillant-yeux-biphase-express', 'lotion-tonique-hydratante-eclat-parfait', 'serum-anti-age-elixir-regard-eclat', 'contour-des-yeux-caresse-regard-energie']);
  assert.deepEqual(day.map((s) => s.chosen_by), [['product'], ['product'], ['product'], ['range', 'concern']]);
  // The common steps are untouched by Y's.
  assert.equal(built.routines.routine_steps.day.length, 4);
});

test('outside the builder, one product among the day types, the serum first', () => {
  assert.deepEqual(F('E').steps.map((s) => s.type), ['serum', 'lotion', 'cleanser', 'cream']);
});

test('the SPF module takes its concerns from the settings, the sheet having them only in a note', () => {
  assert.deepEqual(built.routines.modules.find((m) => m.type === 'spf').when, ['dark_spots', 'uneven_tone']);
});

test('a setting or a range that names nothing is said, never guessed', () => {
  const { warnings } = assembleRoutines({
    routines: { foundations: [{ key: 'A', name_fr: 'A', name_en: 'A', primary_concerns: ['dryness'], preferred_ranges: ['Nulle Part'], range_by_age: false }], steps: { day: [], night: [] }, modules: [] },
    rules: { concerns: [{ key: 'dryness' }], age_ranges: [{ key: '45_plus', range: 'Introuvable' }], routine_times: [], skin_type_texture: {} },
    products: [],
    settings: { foundations: { Z: {} }, concern_map: { dry: 'dryness', odd: 'unknown' }, foundation_priority: ['A', 'Q'] },
  });
  assert.deepEqual(warnings.sort(), [
    'age 45_plus: range « Introuvable » is on no product',
    'concern_map: « odd » → « unknown », not a standard concern',
    'foundation_priority: Q is not a main concern',
    'main concern A: range « Nulle Part » is on no product',
    'settings: foundation Z is not a main concern on the Rules tab',
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
  assert.equal(loaded.routines.routine_steps.night.length, 4);
  const catalogue = { products: [{ id: 'p1', handle: 'creme-nuit-anti-age-caresse-temps-sublime', name: 'Crème Nuit', inStock: true, priceFrom: 68.95, variants: [], collections: [], tags: [] }], collections: [] };
  assert.equal(createAdvisor(read('data/advisor/qiriness.json'), catalogue, { knowledge: loaded.knowledge, routines: loaded.routines }).engine, 'foundations');
  assert.equal(await loadAdvisorKnowledge({ selectAll: async () => [] }, 's'), null, 'no active version: the playbooks run');
});

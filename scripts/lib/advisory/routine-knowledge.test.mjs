import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRoutineRows, parseRuleRows } from './routine-knowledge.mjs';

let line = 0;
const concern = (key, label, effect) => ({ _row: ++line, section: 'Préoccupation · Test', key, label_fr: label, label_en: key, effect });
const RULES = [
  concern('dehydration', 'Déshydratation', 'A Hydratation'),
  concern('dark_spots', 'Taches', 'F Taches'),
  concern('dark_circles', 'Cernes', 'Module Yeux'),
  { _row: ++line, section: 'Type de peau → texture de la crème', key: 'skin_dry', effect: 'Riche' },
];
const step = (foundation, name, order, type, over = {}) => ({ _row: ++line, foundation, name_fr: name, step_order: order, functional_type: type, frequency: 'Quotidien', required: 'Obligatoire', ...over });

test('rules: concerns with their foundation or module, and the cream texture by skin type', () => {
  const rules = parseRuleRows(RULES);
  assert.deepEqual(rules.errors, []);
  assert.deepEqual(rules.concerns.map((c) => [c.key, c.foundation, c.module]), [['dehydration', 'A', null], ['dark_spots', 'F', null], ['dark_circles', null, 'Yeux']]);
  assert.deepEqual(rules.skin_type_texture, { dry: 'rich' });
  assert.equal(parseRuleRows([{ ...RULES[0], effect: 'Hydratation' }]).errors[0].field, 'effect');
});

test('routines: steps in order, concerns as keys (accents and case forgiven), modules from the Rules tab', () => {
  const rules = parseRuleRows(RULES);
  const r = parseRoutineRows([
    step('A', 'Hydratation', 2, 'Sérum', { preferred_range: "Source d'Eau" }),
    step('A', 'Hydratation', 1, 'Nettoyant', { primary_concerns: 'deshydratation' }),
    step('A', 'Hydratation', 3, 'Masque', { frequency: 'Occasionnel', required: 'Optionnel' }),
    step('F', 'Taches', 1, 'Sérum', { primary_concerns: 'Taches' }),
    { _row: ++line, foundation: 'Module', name_fr: 'Yeux', functional_type: 'Yeux', frequency: 'Quotidien', required: 'Optionnel', time_of_day: 'Matin et soir' },
  ], rules);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  const a = r.foundations.find((f) => f.key === 'A');
  assert.deepEqual(a.primary_concerns, ['dehydration']);
  assert.deepEqual(a.steps.map((s) => [s.order, s.type, s.frequency, s.required]), [[1, 'cleanser', 'daily', true], [2, 'serum', 'daily', true], [3, 'mask', 'occasional', false]]);
  assert.deepEqual(a.preferred_ranges, ["Source d'Eau"]);
  assert.deepEqual(r.modules.map((m) => [m.name_fr, m.type, m.time_of_day, m.when]), [['Yeux', 'eye', 'morning_and_evening', ['dark_circles']]]);
});

test('routines: a value outside the dropdowns is an error with its row; nothing is guessed', () => {
  const rules = parseRuleRows(RULES);
  const fields = (rows) => parseRoutineRows(rows, rules).errors.map((e) => e.field);
  assert.deepEqual(fields([step('A', 'Hydratation', 1, 'Patchs')]), ['functional_type']);
  assert.deepEqual(fields([step('B', 'Imperfections', 1, 'Patch')]), []);
  assert.deepEqual(fields([step('A', 'Hydratation', 1, 'Coffret')]), ['functional_type']);
  assert.deepEqual(fields([step('A', 'Hydratation', 1, 'Nettoyant', { primary_concerns: 'Peau qui tire' })]), ['primary_concerns']);
  assert.deepEqual(fields([step('A', 'Hydratation', 1, 'Nettoyant', { required: 'Oui' })]), ['required']);
  assert.deepEqual(fields([step('A', 'Hydratation', 1, 'Nettoyant'), step('A', 'Hydratation', 1, 'Crème')]), ['step_order']);
  assert.deepEqual(fields([step('A', 'Hydratation', 1, 'Nettoyant'), step('A', 'Hydra', 2, 'Crème')]), ['name_fr']);
  const row = parseRoutineRows([step('A', 'Hydratation', 1, 'Patchs')], rules).errors[0].row;
  assert.equal(typeof row, 'number');
});

test('routines and rules must agree; a disagreement is said, not resolved', () => {
  const rules = parseRuleRows(RULES);
  const { warnings } = parseRoutineRows([
    step('A', 'Hydratation', 1, 'Nettoyant'),
    step('F', 'Fermeté et lift', 1, 'Sérum', { primary_concerns: 'Taches, Déshydratation' }),
    step('H', 'Routine de base', 1, 'Nettoyant', { primary_concerns: '(aucune : seulement sur demande)', required: 'Optionnel' }),
  ], rules);
  assert.ok(warnings.some((w) => /Déshydratation.*A, but Routines does not list it/.test(w)));
  assert.ok(warnings.some((w) => /Rules calls F « Taches », Routines calls it « Fermeté et lift »/.test(w)));
  assert.ok(warnings.some((w) => /under F, Rules sends it to A/.test(w)));
  assert.ok(warnings.some((w) => /H « Routine de base » has no required daily step/.test(w)));
  assert.ok(!warnings.some((w) => /H .* has no main concern/.test(w)));
});

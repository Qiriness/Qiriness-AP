import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRoutineRows, parseRuleRows } from './routine-knowledge.mjs';

let line = 0;
const concern = (key, label, effect) => ({ _row: ++line, section: 'Préoccupation · Test', key, label_fr: label, label_en: key, effect });
const main = (key, name, effect) => ({ _row: ++line, section: 'Préoccupation principale (question 1)', key, label_fr: name, label_en: name, effect });
const RULES = [
  concern('dehydration', 'Déshydratation', 'A Hydratation'),
  concern('wrinkles', 'Rides', 'E Anti-âge'),
  concern('redness', 'Rougeurs', 'Type de peau sensible'),
  concern('dark_circles', 'Cernes', 'Module Yeux'),
  main('A', 'Hydratation', "Source d'Eau"),
  main('E', 'Anti-âge', "Selon l'âge"),
  { _row: ++line, section: 'Type de peau → texture de la crème', key: 'skin_dry', effect: 'Riche' },
  { _row: ++line, section: "Âge (question 3) → gamme de l'anti-âge", key: 'under_25', label_fr: 'Moins de 25 ans', label_en: 'Under 25', effect: 'Active Énergie' },
  { _row: ++line, section: "Âge (question 3) → gamme de l'anti-âge", key: '25_44', label_fr: '25 à 44 ans', effect: 'Temps Sublime' },
  { _row: ++line, section: "Âge (question 3) → gamme de l'anti-âge", key: '45_plus', label_fr: '45 ans et plus', effect: 'Exception' },
  { _row: ++line, section: 'Moment de la routine (question 4)', key: 'day', label_fr: 'Routine du jour', label_en: 'Day routine' },
  { _row: ++line, section: 'Moment de la routine (question 4)', key: 'both', label_fr: 'Jour et nuit', label_en: 'Day and night' },
];
const step = (routine, order, types, over = {}) => ({ _row: ++line, routine, step_order: order, name_fr: types, functional_type: types, area: 'Visage', chosen_by: 'Type de peau, Préoccupation', ...over });

test('rules: concerns lead to a main concern, the sensitive skin type or a module; main concerns, ages and moments', () => {
  const rules = parseRuleRows(RULES);
  assert.deepEqual(rules.errors, []);
  assert.deepEqual(rules.concerns.map((c) => [c.key, c.foundation, c.module, c.skin ?? null]), [
    ['dehydration', 'A', null, null], ['wrinkles', 'E', null, null], ['redness', null, null, 'sensitive'], ['dark_circles', null, 'Yeux', null],
  ]);
  assert.deepEqual(rules.foundations.map((f) => [f.key, f.range, f.range_by_age]), [['A', "Source d'Eau", false], ['E', null, true]]);
  assert.deepEqual(rules.age_ranges.map((a) => [a.key, a.min, a.max, a.range]), [['under_25', 0, 24, 'Active Énergie'], ['25_44', 25, 44, 'Temps Sublime'], ['45_plus', 45, null, 'Exception']]);
  assert.deepEqual(rules.routine_times.map((t) => t.key), ['day', 'both']);
  assert.deepEqual(rules.skin_type_texture, { dry: 'rich' });
});

test('rules: a key or an effect the advisor cannot read is an error with its row', () => {
  const fields = (rows) => parseRuleRows(rows).errors.map((e) => [e.field, e.value]);
  assert.deepEqual(fields([{ ...RULES[0], effect: 'Hydratation' }]), [['effect', 'Hydratation']]);
  assert.deepEqual(fields([{ ...RULES[4], key: 'Hydra' }]), [['key', 'Hydra']]);
  assert.deepEqual(fields([{ ...RULES[7], key: 'young' }]), [['key', 'young']]);
  assert.deepEqual(fields([{ ...RULES[7], effect: null }]), [['effect', '(vide)']]);
  assert.deepEqual(fields([{ ...RULES[10], key: 'evening' }]), [['key', 'evening']]);
});

test('routines: the day and night steps in order, with their types, area and criteria; modules from the Rules tab', () => {
  const rules = parseRuleRows(RULES);
  const r = parseRoutineRows([
    step('Jour', 2, 'Sérum', { chosen_by: 'Gamme, Préoccupation', concern_required: 'Oui' }),
    step('Jour', 1, 'Lotion, Nettoyant'),
    step('Jour', 3, 'Sérum, Crème', { area: 'Yeux', chosen_by: 'Gamme ou générique' }),
    step('Nuit', 1, 'Démaquillant'),
    step('Nuit', 2, 'Crème', { chosen_by: 'Gamme, Préoccupation, Moment, Type de peau' }),
    { _row: ++line, routine: 'Module', name_fr: 'Yeux', functional_type: 'Yeux', frequency: 'Quotidien', time_of_day: 'Matin et soir' },
  ], rules);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.steps.day.map((s) => [s.order, s.types, s.area, s.chosen_by, s.concern_required]), [
    [1, ['lotion', 'cleanser'], 'face', ['skin', 'concern'], false],
    [2, ['serum'], 'face', ['range', 'concern'], true],
    [3, ['serum', 'cream'], 'eyes', ['range_or_generic'], false],
  ]);
  assert.deepEqual(r.steps.night.map((s) => s.types[0]), ['makeup_remover', 'cream']);
  assert.deepEqual(r.steps.night[1].chosen_by, ['range', 'concern', 'time', 'skin']);
  assert.deepEqual(r.foundations.map((f) => [f.key, f.primary_concerns, f.preferred_ranges, f.range_by_age]), [['A', ['dehydration'], ["Source d'Eau"], false], ['E', ['wrinkles'], [], true]]);
  assert.deepEqual(r.modules.map((m) => [m.name_fr, m.type, m.time_of_day, m.when]), [['Yeux', 'eye', 'morning_and_evening', ['dark_circles']]]);
});

test('routines: a value outside the dropdowns is an error with its row; nothing is guessed', () => {
  const rules = parseRuleRows(RULES);
  const fields = (rows) => parseRoutineRows(rows, rules).errors.map((e) => e.field);
  assert.deepEqual(fields([step('Jour', 1, 'Patchs')]), ['functional_type']);
  assert.deepEqual(fields([step('Jour', 1, 'Coffret')]), ['functional_type']);
  assert.deepEqual(fields([step('Matin', 1, 'Crème')]), ['routine']);
  assert.deepEqual(fields([step('Jour', 1, 'Crème', { chosen_by: 'Prix' })]), ['chosen_by']);
  assert.deepEqual(fields([step('Jour', 1, 'Crème', { area: 'Cou' })]), ['area']);
  assert.deepEqual(fields([step('Jour', 1, 'Crème', { concern_required: 'Peut-être' })]), ['concern_required']);
  assert.deepEqual(fields([step('Jour', 1, 'Nettoyant'), step('Jour', 1, 'Crème')]), ['step_order']);
  assert.deepEqual(fields([step('Jour', 1, 'Nettoyant'), step('Nuit', 1, 'Crème')]), []);
  assert.equal(typeof parseRoutineRows([step('Jour', 1, 'Patchs')], rules).errors[0].row, 'number');
});

test('routines and rules must agree; a disagreement is said, not resolved', () => {
  const rules = parseRuleRows([...RULES, concern('dullness', 'Teint terne', 'D Éclat'), main('B', 'Imperfections', null), concern('puffiness', 'Poches', 'Module Paupières')]);
  const { warnings } = parseRoutineRows([step('Jour', 1, 'Crème')], rules);
  assert.ok(warnings.includes('Rules: « Teint terne » → D, which is not a main concern'));
  assert.ok(warnings.includes('Main concern B « Imperfections »: no concern leads to it'));
  assert.ok(warnings.includes('Rules: « Poches » → module « Paupières », which the Routines tab does not have'));
  assert.ok(warnings.includes('Routines: no « Nuit » step'));
});

/**
 * Routines and rules: the Routines and Rules tabs of the knowledge spreadsheet
 * (docs/storefront-advisor-plan.md § 2–3), one checked structure out. The
 * Products tab is product-knowledge.mjs.
 *
 * THE DAY / NIGHT ROUTINE (owner, 2026-10-16). The Routines tab is the steps
 * of the day routine and of the night routine, in order, each a product type
 * (or several), an area and the criteria that choose its product, then the
 * modules. The Rules tab is the standard concerns, each leading to a main
 * concern (question 1: a letter), the sensitive skin type or the eyes module;
 * the main concerns with their range (or « Selon l'âge »); the cream texture by
 * skin type; the age ranges and the range each gives; the routine moments.
 *
 * The same rules as the products: a value outside the dropdowns, or a concern
 * outside the brand's standard list, is an error with its spreadsheet row;
 * nothing is guessed. A disagreement between the tabs is a warning, said,
 * never resolved here.
 *
 * Brand-free: the labels are the template's; the concerns, ranges, ages and
 * steps are the brand's rows.
 */
import { ENUMS, FUNCTIONAL_TYPES } from './product-knowledge.mjs';

/** Types that never fill a routine step (a bundle, a device, anything else). */
const NOT_A_STEP = new Set(['coffret', 'kit', 'device', 'tool', 'out_of_routine']);
const MODULE = 'Module';
const ROUTINE = { 'Jour': 'day', 'Nuit': 'night' };
const YES_NO = { 'Oui': true, 'Non': false };
/** « Choisi par »: the criteria that choose a step's product, the first deciding first. */
export const CRITERIA = { 'Gamme': 'range', 'Gamme ou générique': 'range_or_generic', 'Préoccupation': 'concern', 'Moment': 'time', 'Type de peau': 'skin', 'Produit': 'product' };
const CONCERN_SECTION = /^Préoccupation\s*·\s*(.+)$/;
const MAIN_SECTION = /^Préoccupation principale/;
const AGE_SECTION = /^Âge\b/;
const TIME_SECTION = /^Moment de la routine/;
const SENSITIVE_EFFECT = /^Type de peau sensible$/i;
const BY_AGE = /^selon l['’]âge$/i;
const SKIN_KEY = /^skin_(dry|normal|combination|oily)$/;
const TIMES = ['day', 'night', 'both'];

const text = (v) => (v === null || v === undefined ? '' : String(v).trim());
const list = (v) => text(v).split(/\s*[,;\n]\s*/).filter(Boolean);
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** An age range's bounds from its key: under_25, 25_34, 45_plus. */
function ageBounds(key) {
  let m = /^under_(\d+)$/.exec(key);
  if (m) return { min: 0, max: Number(m[1]) - 1 };
  m = /^(\d+)_(\d+)$/.exec(key);
  if (m && Number(m[1]) <= Number(m[2])) return { min: Number(m[1]), max: Number(m[2]) };
  m = /^(\d+)_plus$/.exec(key);
  return m ? { min: Number(m[1]), max: null } : null;
}

/**
 * @param {object[]} rows  the Rules tab, keyed by its (key) names, with `_row`
 * @returns {{ concerns: object[], foundations: object[], age_ranges: object[], routine_times: object[], skin_type_texture: object, skin_labels: object, errors: object[] }}
 */
export function parseRuleRows(rows) {
  const errors = [];
  const bad = (row, field, value) => errors.push({ row: row._row, field, value: value || '(vide)' });
  const concerns = [];
  const foundations = [];
  const ageRanges = [];
  const routineTimes = [];
  const skinTypeTexture = {};
  const skinLabels = {};
  for (const row of rows) {
    const key = text(row.key);
    const sectionName = text(row.section);
    const section = CONCERN_SECTION.exec(sectionName);
    const labels = { label_fr: text(row.label_fr), label_en: text(row.label_en) || null };
    if (MAIN_SECTION.test(sectionName)) {
      // A main concern: its letter, its name, its range (or the range by age).
      if (!/^[A-Z]$/.test(key)) { bad(row, 'key', key); continue; }
      const effect = text(row.effect);
      foundations.push({ key, name_fr: labels.label_fr, name_en: labels.label_en, range: BY_AGE.test(effect) ? null : effect || null, range_by_age: BY_AGE.test(effect), note: text(row.note) || null });
    } else if (section) {
      // « A Hydratation » → main concern A; « Module Yeux » → the module named Yeux; « Type de peau sensible ».
      const effect = text(row.effect);
      const sensitive = SENSITIVE_EFFECT.test(effect);
      const module = effect.startsWith(`${MODULE} `) ? effect.slice(MODULE.length + 1) : null;
      const foundation = module || sensitive ? null : /^([A-Z])\b\s*(.*)$/.exec(effect);
      if (!module && !foundation && !sensitive) bad(row, 'effect', effect);
      concerns.push({
        key, ...labels, family: section[1],
        foundation: foundation?.[1] ?? null, foundation_name: foundation?.[2] || null, module,
        ...(sensitive ? { skin: 'sensitive' } : {}),
        secondary_effect: text(row.secondary_effect) || null,
      });
    } else if (AGE_SECTION.test(sectionName)) {
      if (!key) continue;
      const bounds = ageBounds(key);
      if (!bounds) bad(row, 'key', key);
      else if (!text(row.effect)) bad(row, 'effect', '');
      else ageRanges.push({ key, ...labels, ...bounds, range: text(row.effect) });
    } else if (TIME_SECTION.test(sectionName)) {
      if (!key) continue;
      if (!TIMES.includes(key)) bad(row, 'key', key);
      else routineTimes.push({ key, ...labels });
    } else if (SKIN_KEY.test(key)) {
      const texture = ENUMS.texture[text(row.effect)];
      if (!texture) bad(row, 'effect', text(row.effect));
      else skinTypeTexture[SKIN_KEY.exec(key)[1]] = texture;
      if (labels.label_fr) skinLabels[SKIN_KEY.exec(key)[1]] = { fr: labels.label_fr, en: labels.label_en };
    }
  }
  return { concerns, foundations, age_ranges: ageRanges, routine_times: routineTimes, skin_type_texture: skinTypeTexture, skin_labels: skinLabels, errors };
}

/**
 * @param {object[]} rows  the Routines tab, keyed by its (key) names, with `_row`
 * @param {{ concerns: object[], foundations: object[] }} rules  parseRuleRows' output
 * @returns {{ foundations: object[], steps: { day: object[], night: object[] }, own_steps: object, modules: object[], errors: object[], warnings: string[] }}
 *   own_steps: { <main concern letter>: { day, night } }, the steps a main concern has instead of the
 *   common ones (owner, 2026-10-17: the eye routine). A step's `product` (a handle) is the product it
 *   always takes (« Choisi par » = Produit), or the one it takes when no product meets its criteria.
 */
export function parseRoutineRows(rows, { concerns, foundations: mains = [] }) {
  const errors = [];
  const warnings = [];
  const bad = (row, field, value) => errors.push({ row: row._row, field, value: String(value) });
  const pick = (row, field, map, { required = false } = {}) => {
    const v = text(row[field]);
    if (!v) { if (required) bad(row, field, '(vide)'); return null; }
    if (!(v in map)) { bad(row, field, v); return null; }
    return map[v];
  };
  const typeOf = (row, label) => {
    const type = FUNCTIONAL_TYPES[label];
    if (!type) bad(row, 'functional_type', label);
    else if (NOT_A_STEP.has(type)) bad(row, 'functional_type', `${label} (not a routine step)`);
    else return type;
    return null;
  };

  const steps = { day: [], night: [] };
  const own = {};
  const modules = [];
  for (const row of rows) {
    const routine = text(row.routine);
    if (routine === MODULE) {
      const name = text(row.name_fr);
      const type = list(row.functional_type).map((label) => typeOf(row, label))[0] ?? null;
      modules.push({
        name_fr: name, name_en: text(row.name_en) || null, type,
        frequency: pick(row, 'frequency', ENUMS.frequency, { required: true }), required: false,
        time_of_day: pick(row, 'time_of_day', ENUMS.time_of_day), note: text(row.note) || null,
        when: concerns.filter((c) => c.module && fold(c.module) === fold(name)).map((c) => c.key),
        when_note: text(row.primary_concerns) || null,
      });
      continue;
    }
    const part = ROUTINE[routine];
    if (!part) { bad(row, 'routine', routine || '(vide)'); continue; }
    // A main concern's own steps (« Y »), instead of the common ones.
    const main = text(row.main_concern);
    if (main && !mains.some((f) => f.key === main)) { bad(row, 'main_concern', main); continue; }
    const into = main ? (own[main] ??= { day: [], night: [] })[part] : steps[part];
    const order = Number(row.step_order);
    if (!Number.isInteger(order) || order < 1) bad(row, 'step_order', text(row.step_order) || '(vide)');
    else if (into.some((s) => s.order === order)) bad(row, 'step_order', `${order} (twice in ${routine}${main ? ` ${main}` : ''})`);
    const types = list(row.functional_type).map((label) => typeOf(row, label)).filter(Boolean);
    if (!list(row.functional_type).length) bad(row, 'functional_type', '(vide)');
    const chosenBy = list(row.chosen_by).map((label) => {
      if (!(label in CRITERIA)) bad(row, 'chosen_by', label);
      return CRITERIA[label];
    }).filter(Boolean);
    if (!list(row.chosen_by).length) bad(row, 'chosen_by', '(vide)');
    const product = text(row.product) || null;
    if (chosenBy.includes('product') && !product) bad(row, 'product', '(vide)');
    into.push({
      order, name_fr: text(row.name_fr), name_en: text(row.name_en) || null, types,
      area: pick(row, 'area', ENUMS.area) ?? 'face', chosen_by: chosenBy,
      concern_required: pick(row, 'concern_required', YES_NO) ?? false, note: text(row.note) || null,
      ...(product ? { product } : {}),
    });
  }
  for (const part of Object.keys(steps)) {
    steps[part].sort((a, b) => a.order - b.order);
    if (!steps[part].length) warnings.push(`Routines: no « ${part === 'day' ? 'Jour' : 'Nuit'} » step`);
  }
  for (const [main, parts] of Object.entries(own)) {
    for (const part of Object.keys(parts)) parts[part].sort((a, b) => a.order - b.order);
    if (!parts.day.length || !parts.night.length) warnings.push(`Routines: main concern ${main} has its own steps for ${parts.day.length ? 'the day' : 'the night'} only`);
  }

  // The main concerns (Rules tab) with the standard concerns that lead to them.
  const foundations = mains.map((f) => ({
    key: f.key, name_fr: f.name_fr, name_en: f.name_en,
    primary_concerns: concerns.filter((c) => c.foundation === f.key).map((c) => c.key),
    preferred_ranges: f.range ? [f.range] : [], range_by_age: f.range_by_age, note: f.note,
  }));
  for (const c of concerns) {
    if (c.foundation) {
      const f = foundations.find((x) => x.key === c.foundation);
      if (!f) warnings.push(`Rules: « ${c.label_fr} » → ${c.foundation}, which is not a main concern`);
      else if (c.foundation_name && fold(c.foundation_name) !== fold(f.name_fr)) warnings.push(`Rules calls ${c.foundation} « ${c.foundation_name} » for « ${c.label_fr} », its main concern row « ${f.name_fr} »`);
    }
    if (c.module && !modules.some((m) => fold(m.name_fr) === fold(c.module))) warnings.push(`Rules: « ${c.label_fr} » → module « ${c.module} », which the Routines tab does not have`);
  }
  for (const f of foundations) if (!f.primary_concerns.length) warnings.push(`Main concern ${f.key} « ${f.name_fr} »: no concern leads to it`);
  return { foundations, steps, own_steps: own, modules, errors, warnings: [...new Set(warnings)] };
}

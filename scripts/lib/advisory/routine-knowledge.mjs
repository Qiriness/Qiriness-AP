/**
 * Routines and rules: the Routines and Rules tabs of the knowledge spreadsheet
 * (docs/storefront-advisor-plan.md § 2–3), one checked structure out. The
 * Products tab is product-knowledge.mjs.
 *
 * The same rules as the products: a value outside the dropdowns, or a concern
 * outside the brand's standard list, is an error with its spreadsheet row;
 * nothing is guessed. The two tabs must agree: a concern the Rules tab sends to
 * a foundation is one of that foundation's main concerns on the Routines tab.
 * A disagreement there is a warning, said, never resolved here.
 *
 * Brand-free: the labels are the template's; the foundations, their names and
 * their steps are the brand's rows.
 */
import { ENUMS, FUNCTIONAL_TYPES } from './product-knowledge.mjs';

const REQUIRED = { 'Obligatoire': true, 'Optionnel': false };
/** Types that never fill a routine step (a bundle, a device, anything else). */
const NOT_A_STEP = new Set(['coffret', 'kit', 'device', 'tool', 'out_of_routine']);
const MODULE = 'Module';
const CONCERN_SECTION = /^Préoccupation\s*·\s*(.+)$/;
const SKIN_KEY = /^skin_(dry|normal|combination|oily)$/;

const text = (v) => (v === null || v === undefined ? '' : String(v).trim());
const list = (v) => text(v).split(/\s*[,;\n]\s*/).filter(Boolean);
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * @param {object[]} rows  the Rules tab, keyed by its (key) names, with `_row`
 * @returns {{ concerns: object[], skin_type_texture: object, errors: object[] }}
 */
export function parseRuleRows(rows) {
  const errors = [];
  const concerns = [];
  const skinTypeTexture = {};
  for (const row of rows) {
    const key = text(row.key);
    const section = CONCERN_SECTION.exec(text(row.section));
    if (section) {
      // « A Hydratation » → foundation A; « Module Yeux » → the module named Yeux.
      const effect = text(row.effect);
      const module = effect.startsWith(`${MODULE} `) ? effect.slice(MODULE.length + 1) : null;
      const foundation = module ? null : /^([A-Z])\b\s*(.*)$/.exec(effect);
      if (!module && !foundation) errors.push({ row: row._row, field: 'effect', value: effect || '(vide)' });
      concerns.push({
        key, label_fr: text(row.label_fr), label_en: text(row.label_en), family: section[1],
        foundation: foundation?.[1] ?? null, foundation_name: foundation?.[2] || null, module,
        secondary_effect: text(row.secondary_effect) || null,
      });
    } else if (SKIN_KEY.test(key)) {
      const texture = ENUMS.texture[text(row.effect)];
      if (!texture) errors.push({ row: row._row, field: 'effect', value: text(row.effect) || '(vide)' });
      else skinTypeTexture[SKIN_KEY.exec(key)[1]] = texture;
    }
  }
  return { concerns, skin_type_texture: skinTypeTexture, errors };
}

/**
 * @param {object[]} rows  the Routines tab, keyed by its (key) names, with `_row`
 * @param {{ concerns: object[] }} rules  parseRuleRows' concerns
 * @returns {{ foundations: object[], modules: object[], errors: object[], warnings: string[] }}
 */
export function parseRoutineRows(rows, { concerns }) {
  const byLabel = new Map(concerns.map((c) => [fold(c.label_fr), c.key]));
  const errors = [];
  const warnings = [];
  const bad = (row, field, value) => errors.push({ row: row._row, field, value: String(value) });
  const pick = (row, field, map, { required = false } = {}) => {
    const v = text(row[field]);
    if (!v) { if (required) bad(row, field, '(vide)'); return null; }
    if (!(v in map)) { bad(row, field, v); return null; }
    return map[v];
  };
  const step = (row) => {
    const type = pick(row, 'functional_type', FUNCTIONAL_TYPES, { required: true });
    if (type && NOT_A_STEP.has(type)) bad(row, 'functional_type', `${row.functional_type} (not a routine step)`);
    return {
      type, frequency: pick(row, 'frequency', ENUMS.frequency, { required: true }),
      required: pick(row, 'required', REQUIRED, { required: true }),
      time_of_day: pick(row, 'time_of_day', ENUMS.time_of_day), note: text(row.note) || null,
    };
  };

  const foundations = new Map();
  const modules = [];
  for (const row of rows) {
    const key = text(row.foundation);
    if (key === MODULE) {
      const name = text(row.name_fr);
      modules.push({
        name_fr: name, name_en: text(row.name_en) || null, ...step(row),
        when: concerns.filter((c) => c.module && fold(c.module) === fold(name)).map((c) => c.key),
        when_note: text(row.primary_concerns) || null,
      });
      continue;
    }
    if (!/^[A-Z]$/.test(key)) { bad(row, 'foundation', key || '(vide)'); continue; }
    let f = foundations.get(key);
    if (!f) {
      f = { key, name_fr: text(row.name_fr), name_en: text(row.name_en) || null, primary_concerns: [], preferred_ranges: [], premium_variant: null, concerns_note: null, steps: [] };
      foundations.set(key, f);
    }
    if (text(row.name_fr) && text(row.name_fr) !== f.name_fr) bad(row, 'name_fr', `${row.name_fr} (foundation ${key} is « ${f.name_fr} »)`);
    // The main concerns: standard labels; a cell in brackets is a note, not a concern.
    const cell = text(row.primary_concerns);
    if (cell.startsWith('(')) f.concerns_note = cell;
    else for (const label of list(cell)) {
      const concern = byLabel.get(fold(label));
      if (!concern) bad(row, 'primary_concerns', label);
      else if (!f.primary_concerns.includes(concern)) f.primary_concerns.push(concern);
    }
    const range = text(row.preferred_range);
    if (range && !f.preferred_ranges.includes(range)) f.preferred_ranges.push(range);
    const premium = text(row.premium_variant);
    if (premium) f.premium_variant ??= premium;
    const order = Number(row.step_order);
    if (!Number.isInteger(order) || order < 1) bad(row, 'step_order', text(row.step_order) || '(vide)');
    else if (f.steps.some((s) => s.order === order)) bad(row, 'step_order', `${order} (twice in ${key})`);
    f.steps.push({ order, ...step(row), preferred_range: range || null });
  }
  for (const f of foundations.values()) f.steps.sort((a, b) => a.order - b.order);

  // The two tabs agree: each concern's foundation lists it, under the same name.
  for (const c of concerns) {
    if (!c.foundation) {
      if (c.module && !modules.some((m) => fold(m.name_fr) === fold(c.module))) warnings.push(`Rules: « ${c.label_fr} » → module « ${c.module} », which the Routines tab does not have`);
      continue;
    }
    const f = foundations.get(c.foundation);
    if (!f) { warnings.push(`Rules: « ${c.label_fr} » → foundation ${c.foundation}, which the Routines tab does not have`); continue; }
    if (!f.primary_concerns.includes(c.key)) warnings.push(`Rules: « ${c.label_fr} » → ${c.foundation}, but Routines does not list it among ${c.foundation}'s main concerns`);
    if (c.foundation_name && fold(c.foundation_name) !== fold(f.name_fr)) warnings.push(`Rules calls ${c.foundation} « ${c.foundation_name} », Routines calls it « ${f.name_fr} » (« ${c.label_fr} »)`);
  }
  for (const f of foundations.values()) {
    for (const concern of f.primary_concerns) {
      const rule = concerns.find((c) => c.key === concern);
      if (rule && rule.foundation !== f.key) warnings.push(`Routines lists « ${rule.label_fr} » under ${f.key}, Rules sends it to ${rule.foundation ?? `module ${rule.module}`}`);
    }
    if (!f.primary_concerns.length && !f.concerns_note) warnings.push(`Foundation ${f.key} « ${f.name_fr} » has no main concern`);
    if (!f.steps.some((s) => s.required && s.frequency === 'daily')) warnings.push(`Foundation ${f.key} « ${f.name_fr} » has no required daily step: its Essential size is empty`);
  }
  return { foundations: [...foundations.values()], modules, errors, warnings: [...new Set(warnings)] };
}

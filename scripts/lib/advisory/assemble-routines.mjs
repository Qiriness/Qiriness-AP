/**
 * THE ROUTINES THE ENGINE RUNS, assembled from the knowledge spreadsheet and
 * the brand's routine settings (plan § 2, « Assemble the routines the engine
 * runs »; owner made it live on 2026-10-16).
 *
 *   spreadsheet  foundations, their ordered steps (type, daily/occasional,
 *                required), main concerns, preferred range, premium variant;
 *                modules and their concerns; cream texture by skin type
 *   settings     what the sheet does not carry: which steps must treat the
 *                concern (`targets`), skin types that pick a foundation,
 *                tolerance first, the basic routine, the customer's words →
 *                standard concerns, priority, questions, treats
 *
 * Same shape as data/advisor/sample-routines/routines.json, which the engine
 * (foundations.mjs) is tested on. A setting that names nothing in the sheet,
 * or a range no product carries, is a warning: said, never guessed.
 * Brand-free: every name comes from the two inputs.
 */

const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').replace(/[’‘`´]/g, "'").toLowerCase().trim();
const withoutNotes = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !k.startsWith('_')));

/**
 * @param {{ routines: { foundations: object[], modules: object[] }, rules: { concerns: object[], skin_type_texture: object },
 *           products: object[], settings: object }} input
 *   routines, rules: parseRoutineRows / parseRuleRows; products: parseKnowledgeRows(...).products
 * @returns {{ routines: object, warnings: string[] }}
 */
export function assembleRoutines({ routines, rules, products, settings }) {
  const warnings = [];
  const concernKeys = new Set(rules.concerns.map((c) => c.key));
  // A range as the products spell it: « Source d'Eau » on the Routines tab is « Source d’Eau » on the Products tab.
  const ranges = [...new Set(products.map((p) => p.range).filter(Boolean))];
  const rangeOf = (name, where) => {
    if (!name) return null;
    const hit = ranges.find((r) => fold(r) === fold(name));
    if (!hit) warnings.push(`${where}: range « ${name} » is on no product`);
    return hit ?? null;
  };

  const perFoundation = withoutNotes(settings.foundations);
  const foundations = routines.foundations.map((f) => {
    const extra = perFoundation[f.key] ?? {};
    const types = new Set(f.steps.map((s) => s.type));
    const targets = extra.targets ?? [];
    for (const t of targets) if (!types.has(t)) warnings.push(`foundation ${f.key}: target « ${t} » is not one of its steps`);
    const { targets: _t, ...rest } = extra;
    return {
      key: f.key,
      name_fr: f.name_fr,
      name_en: f.name_en,
      primary_concerns: f.primary_concerns,
      preferred_range: rangeOf(f.preferred_ranges?.[0], `foundation ${f.key}`),
      ...(f.premium_variant ? { premium_variant: rangeOf(f.premium_variant, `foundation ${f.key} premium`) } : {}),
      steps: f.steps.map((s) => ({
        order: s.order,
        type: s.type,
        frequency: s.frequency,
        required: s.required,
        ...(targets.includes(s.type) ? { targets: 'primary' } : {}),
        ...(s.time_of_day ? { time_of_day: s.time_of_day } : {}),
        ...(s.note ? { note: s.note } : {}),
      })),
      ...rest,
    };
  });
  for (const key of Object.keys(perFoundation)) if (!foundations.some((f) => f.key === key)) warnings.push(`settings: foundation ${key} is not on the Routines tab`);

  const perModule = withoutNotes(settings.modules);
  const modules = routines.modules.map((m) => {
    const extra = perModule[m.type];
    if (!extra) warnings.push(`module « ${m.name_fr} » (${m.type}) has no settings: keyed by its type`);
    const when = [...new Set([...(m.when ?? []), ...(extra?.when ?? [])])];
    for (const c of when) if (!concernKeys.has(c)) warnings.push(`module ${m.type}: concern « ${c} » is not a standard concern`);
    return { key: extra?.key ?? m.type, name_fr: m.name_fr, name_en: m.name_en, type: m.type, frequency: m.frequency, when, ...(extra?.standalone ? { standalone: true } : {}), ...(extra?.when_size ? { when_size: extra.when_size } : {}) };
  });

  const concernMap = withoutNotes(settings.concern_map);
  for (const [word, concern] of Object.entries(concernMap)) if (!concernKeys.has(concern)) warnings.push(`concern_map: « ${word} » → « ${concern} », not a standard concern`);
  const priority = settings.foundation_priority ?? [];
  for (const key of priority) if (!foundations.some((f) => f.key === key)) warnings.push(`foundation_priority: ${key} is not a foundation`);
  for (const f of foundations) if (f.primary_concerns.length && !priority.includes(f.key)) warnings.push(`foundation_priority: ${f.key} is missing`);

  return {
    routines: {
      _about: 'Assembled by npm run advisor:load from the knowledge spreadsheet and the brand routine settings (assemble-routines.mjs). Do not edit: change the sources.',
      concern_map: concernMap,
      premium_concerns: settings.premium_concerns ?? [],
      foundation_priority: priority,
      eye_concerns: modules.find((m) => m.type === 'eye')?.when ?? [],
      foundations,
      skin_type_texture: rules.skin_type_texture ?? {},
      modules,
      questions: settings.questions ?? {},
      treats: settings.treats ?? {},
    },
    warnings,
  };
}

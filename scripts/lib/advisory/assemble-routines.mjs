/**
 * THE ROUTINES THE ENGINE RUNS, assembled from the knowledge spreadsheet and
 * the brand's routine settings (plan § 2, « Assemble the routines the engine
 * runs »; owner made it live on 2026-10-16; the day / night routine, owner
 * 2026-10-16).
 *
 *   spreadsheet  the day and night steps (types, area, the criteria that
 *                choose each product); the main concerns, their concerns and
 *                range (or the range by age); the age ranges; the routine
 *                moments; cream texture by skin type; modules
 *   settings     what the sheet does not carry: the customer's words →
 *                standard concerns, the tie between main concerns, a skin type
 *                that picks one, questions, treats
 *
 * The engine (foundations.mjs) runs the day / night steps in the builder; the
 * main concerns also carry one step per day type, which it uses for a single
 * product outside the builder (« un soin pour mes rides »). A setting that
 * names nothing in the sheet, or a range no product carries, is a warning:
 * said, never guessed. Brand-free: every name comes from the two inputs.
 */

const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').replace(/[’‘`´]/g, "'").toLowerCase().trim();
const withoutNotes = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !k.startsWith('_')));

/**
 * @param {{ routines: { foundations: object[], steps: { day: object[], night: object[] }, modules: object[] },
 *           rules: { concerns: object[], age_ranges: object[], routine_times: object[], skin_type_texture: object },
 *           products: object[], settings: object }} input
 *   routines, rules: parseRoutineRows / parseRuleRows; products: parseKnowledgeRows(...).products
 * @returns {{ routines: object, warnings: string[] }}
 */
export function assembleRoutines({ routines, rules, products, settings }) {
  const warnings = [];
  const concernKeys = new Set(rules.concerns.map((c) => c.key));
  // A range as the products spell it: « Source d'Eau » on the Rules tab is « Source d’Eau » on the Products tab.
  const ranges = [...new Set(products.map((p) => p.range).filter(Boolean))];
  const rangeOf = (name, where) => {
    if (!name) return null;
    const hit = ranges.find((r) => fold(r) === fold(name));
    if (!hit) warnings.push(`${where}: range « ${name} » is on no product`);
    return hit ?? null;
  };

  // One step per type of the day routine's face steps, the concern's own first (the serum):
  // a single product for one need is chosen among them.
  const dayFace = [...(routines.steps?.day ?? [])].filter((s) => s.area === 'face').sort((a, b) => Number(b.concern_required) - Number(a.concern_required) || a.order - b.order);
  const singleSteps = [...new Set(dayFace.flatMap((s) => s.types))].map((type, i) => ({ order: i + 1, type, frequency: 'daily', required: true, targets: 'primary' }));

  const perFoundation = withoutNotes(settings.foundations);
  const foundations = routines.foundations.map((f) => ({
    key: f.key,
    name_fr: f.name_fr,
    name_en: f.name_en,
    primary_concerns: f.primary_concerns,
    preferred_range: rangeOf(f.preferred_ranges?.[0], `main concern ${f.key}`),
    ...(f.range_by_age ? { range_by_age: true } : {}),
    steps: singleSteps,
    // Its own day and night steps (the eye routine), instead of the common ones.
    ...(routines.own_steps?.[f.key] ? { routine_steps: routines.own_steps[f.key] } : {}),
    ...(perFoundation[f.key] ?? {}),
  }));
  // A step's product (« Produit »): a handle the Products tab advises.
  const advised = new Map(products.map((p) => [p.handle, p]));
  for (const [where, parts] of [['common', routines.steps ?? {}], ...Object.entries(routines.own_steps ?? {})]) {
    for (const step of [...(parts.day ?? []), ...(parts.night ?? [])]) {
      if (!step.product) continue;
      const p = advised.get(step.product);
      if (!p) warnings.push(`Routines (${where}) step « ${step.name_fr} »: product « ${step.product} » is not an approved product on the Products tab`);
      else if (p.status === 'do_not_advise') warnings.push(`Routines (${where}) step « ${step.name_fr} »: product « ${step.product} » is « Ne pas conseiller »`);
    }
  }
  for (const key of Object.keys(perFoundation)) if (!foundations.some((f) => f.key === key)) warnings.push(`settings: foundation ${key} is not a main concern on the Rules tab`);

  const ageRanges = (rules.age_ranges ?? []).map((a) => ({ ...a, range: rangeOf(a.range, `age ${a.key}`) }));
  if (foundations.some((f) => f.range_by_age) && !ageRanges.length) warnings.push('a main concern takes its range by age, and the Rules tab has no age range');

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
  for (const key of priority) if (!foundations.some((f) => f.key === key)) warnings.push(`foundation_priority: ${key} is not a main concern`);
  for (const f of foundations) if (f.primary_concerns.length && !priority.includes(f.key)) warnings.push(`foundation_priority: ${f.key} is missing`);

  return {
    routines: {
      _about: 'Assembled by npm run advisor:load from the knowledge spreadsheet and the brand routine settings (assemble-routines.mjs). Do not edit: change the sources.',
      concern_map: concernMap,
      premium_concerns: settings.premium_concerns ?? [],
      foundation_priority: priority,
      // The eye module's concerns, and an eye routine's (a main concern with `area: eyes` in the settings).
      eye_concerns: [...new Set([...(modules.find((m) => m.type === 'eye')?.when ?? []), ...foundations.filter((f) => f.area === 'eyes').flatMap((f) => f.primary_concerns)])],
      sensitive_concerns: rules.concerns.filter((c) => c.skin === 'sensitive').map((c) => c.key),
      foundations,
      routine_steps: routines.steps,
      age_ranges: ageRanges,
      routine_times: rules.routine_times ?? [],
      skin_type_texture: rules.skin_type_texture ?? {},
      modules,
      questions: settings.questions ?? {},
      treats: settings.treats ?? {},
    },
    warnings,
  };
}

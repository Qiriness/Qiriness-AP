/**
 * Product knowledge: what the brand says about each product, beyond Shopify
 * (docs/storefront-advisor-plan.md § 2). One row of the Products tab of the
 * knowledge spreadsheet in, one checked record out.
 *
 * The importer's rules, whatever file format carries the rows:
 *   - Only rows the brand approved (« Validé », « Corrigé ») advise; « Ne pas
 *     conseiller » is kept so the product is never recommended. Others are skipped.
 *   - A value outside the spreadsheet's dropdown, or a concern outside the
 *     brand's standard list, rejects the row with a reason. Nothing is guessed.
 *   - A blank cell is « not stated », never « no » (a blank skin type is not
 *     « Non adapté »).
 *   - The grey columns (Shopify facts, measured repurchase) are not knowledge:
 *     Shopify and the orders stay their source.
 *
 * Channel-free and brand-free: the labels are the template's dropdowns; which
 * engine step a functional type fills is the brand config's `functional_types`.
 */

/** The Products tab's columns, by their (key) names, in order. */
export const TEMPLATE_KEYS = [
  'handle', 'title', 'price', 'stock', 'range', 'status', 'functional_type', 'ritual_stage', 'frequency', 'usage_weeks',
  'measured_repurchase_weeks', 'measured_repurchase_detail', 'time_of_day', 'area', 'primary_concern', 'other_concerns',
  'skin_dry', 'skin_normal', 'skin_combination', 'skin_oily', 'texture', 'sensitive', 'contains', 'precautions', 'compatibility',
  'men', 'premium', 'treat', 'gift', 'kit_contents', 'usage', 'actives', 'faq_count', 'note',
];

const STATUS = { 'Validé': 'validated', 'Corrigé': 'corrected', 'Ne pas conseiller': 'do_not_advise' };
const SKIPPED_STATUS = new Set(['À valider', 'Exemple', '']);

export const FUNCTIONAL_TYPES = {
  'Nettoyant': 'cleanser',
  'Exfoliant': 'exfoliant',
  'Lotion': 'lotion',
  'Sérum': 'serum',
  'Crème': 'cream',
  'SPF': 'spf',
  'Yeux': 'eye',
  'Masque': 'mask',
  'Coffret / kit': 'kit',
  'Accessoire': 'tool',
  'Hors routine': 'out_of_routine',
};
const ENUMS = {
  ritual_stage: { 'Préparer': 'prepare', 'Activer': 'activate', 'Optimiser': 'optimise', 'Régénérer': 'regenerate' },
  frequency: { 'Quotidien': 'daily', 'Occasionnel': 'occasional' },
  time_of_day: { 'Matin': 'morning', 'Soir': 'evening', 'Matin et soir': 'morning_and_evening' },
  area: { 'Visage': 'face', 'Yeux': 'eyes', 'Lèvres': 'lips', 'Corps': 'body', 'Mains': 'hands', 'Pieds': 'feet' },
  texture: { 'Riche': 'rich', 'Standard': 'standard', 'Légère': 'light' },
  sensitive: { 'Adapté': 'suitable', 'Avec précaution': 'caution', 'Déconseillé': 'avoid' },
};
const SKIN = { 'Idéal': 'ideal', 'Adapté': 'suitable', 'Non adapté': 'unsuitable' };
const SKIN_COLUMNS = { skin_dry: 'dry', skin_normal: 'normal', skin_combination: 'combination', skin_oily: 'oily' };
const YES_NO = { 'Oui': true, 'Non': false };
const FLAGS = ['men', 'premium', 'treat', 'gift'];
const HANDLE = /^[a-z0-9][a-z0-9-]{0,254}$/;

const text = (v) => (v === null || v === undefined ? '' : String(v).trim());
const list = (v) => text(v).split(/\s*[,;\n]\s*/).filter(Boolean);

/**
 * @param {object[]} rows  objects keyed by the spreadsheet's (key) names, values as typed
 * @param {{ concerns: { key: string, label_fr: string }[] }} rules  the Rules tab's standard concerns
 * @returns {{ products: object[], skipped: { handle: string, status: string }[], errors: { handle: string, field: string, value: string }[] }}
 */
export function parseKnowledgeRows(rows, { concerns }) {
  const concernByLabel = new Map(concerns.map((c) => [c.label_fr.toLowerCase(), c.key]));
  const handles = new Set(rows.map((r) => text(r.handle)).filter(Boolean));
  const products = [];
  const skipped = [];
  const errors = [];
  for (const row of rows) {
    const handle = text(row.handle);
    if (!handle) continue;
    const status = text(row.status);
    if (SKIPPED_STATUS.has(status)) { skipped.push({ handle, status }); continue; }
    const rowErrors = [];
    const bad = (field, value) => rowErrors.push({ handle, field, value: String(value) });
    const pick = (field, map) => {
      const v = text(row[field]);
      if (!v) return null;
      if (!(v in map)) { bad(field, v); return null; }
      return map[v];
    };

    if (!HANDLE.test(handle)) bad('handle', handle);
    const record = { handle, status: pick('status', STATUS) };
    record.functional_type = pick('functional_type', FUNCTIONAL_TYPES);
    if (!record.functional_type && !rowErrors.length) bad('functional_type', '(vide)');
    record.range = text(row.range) || null;
    for (const [field, map] of Object.entries(ENUMS)) record[field] = pick(field, map);

    const weeks = text(row.usage_weeks);
    record.usage_weeks = null;
    if (weeks) {
      const n = Number(weeks.replace(',', '.'));
      if (Number.isInteger(n) && n >= 1 && n <= 104) record.usage_weeks = n;
      else bad('usage_weeks', weeks);
    }

    const concern = (label) => {
      const key = concernByLabel.get(label.toLowerCase());
      if (!key) bad('concern', label);
      return key ?? null;
    };
    record.primary_concern = text(row.primary_concern) ? concern(text(row.primary_concern)) : null;
    record.other_concerns = list(row.other_concerns).map(concern).filter(Boolean);

    record.skin = Object.fromEntries(Object.entries(SKIN_COLUMNS).map(([field, skin]) => [skin, pick(field, SKIN)]));
    record.contains = list(row.contains);
    record.precautions = text(row.precautions) || null;
    record.compatibility = text(row.compatibility) || null;
    for (const flag of FLAGS) record[flag] = pick(flag, YES_NO);

    record.kit_contents = list(row.kit_contents);
    if (record.kit_contents.length && record.functional_type !== 'kit') bad('kit_contents', 'only for « Coffret / kit »');
    for (const h of record.kit_contents) if (!handles.has(h) || h === handle) bad('kit_contents', h);

    if (rowErrors.length) errors.push(...rowErrors);
    else products.push(record);
  }
  return { products, skipped, errors };
}

/** Records by handle, for the engine and the purchase turn. */
export function knowledgeIndex(products) {
  return new Map((products ?? []).map((p) => [p.handle, p]));
}

/** A kit's contents, as handles; a product that is not a kit is itself. */
export function coveredHandles(handle, index) {
  const k = index?.get(handle);
  return k?.functional_type === 'kit' && k.kit_contents.length ? k.kit_contents : [handle];
}

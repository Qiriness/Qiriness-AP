/**
 * THE KNOWLEDGE THE FOUNDATION ENGINE RUNS, from the spreadsheet to the
 * database and back (`advisor_knowledge`, one version per load; owner made the
 * spreadsheet live on 2026-10-16).
 *
 *   build   the spreadsheet's transcription (data/advisor/<brand>-knowledge.json)
 *           + the brand's routine settings → product knowledge + routines, with
 *           the rules' errors and the assembly's warnings
 *   row     what `npm run advisor:load` writes: the next version, active
 *   load    what the storefront service reads: the shop's active version, as
 *           createAdvisor(…, { knowledge, routines }) takes it
 *
 * Products are kept by handle, so the same knowledge serves a dev store that
 * shares the handles. Brand-free: everything comes from the two files.
 */
import { ADVISOR_T } from './advisory-repository.mjs';
import { assembleRoutines } from './assemble-routines.mjs';
import { knowledgeIndex, parseKnowledgeRows } from './product-knowledge.mjs';
import { parseRoutineRows, parseRuleRows } from './routine-knowledge.mjs';

/**
 * @param {{ sheet: { products: object[], routines: object[], rules: object[] }, settings: object }} input
 * @returns {{ products: object[], routines: object, errors: string[], warnings: string[] }}
 */
export function buildAdvisorKnowledge({ sheet, settings }) {
  const rules = parseRuleRows(sheet.rules);
  const parsedRoutines = parseRoutineRows(sheet.routines, rules);
  const parsed = parseKnowledgeRows(sheet.products, { concerns: rules.concerns });
  // { row, field, value } from the row rules, said with the tab and the spreadsheet line.
  const said = (tab) => (e) => (typeof e === 'string' ? `${tab}: ${e}` : `${tab} row ${e.row ?? '?'}: ${e.field ?? ''} « ${e.value ?? ''} »${e.reason ? ` (${e.reason})` : ''}`);
  const errors = [...rules.errors.map(said('Rules')), ...parsedRoutines.errors.map(said('Routines')), ...parsed.errors.map(said('Products'))];
  const { routines, warnings } = assembleRoutines({ routines: parsedRoutines, rules, products: parsed.products, settings });
  return { products: parsed.products, routines, errors, warnings: [...(parsedRoutines.warnings ?? []), ...warnings] };
}

/** The row a load writes: the next version, active. */
export function knowledgeRow({ shopId, version, source, products, routines, warnings = [] }) {
  return { shop_id: shopId, version, status: 'active', source, products, routines, warnings };
}

/**
 * @param {{ selectAll: (table: string, filters: object, columns: string) => Promise<object[]> }} db
 * @returns {Promise<{ version: number, knowledge: Map<string, object>, routines: object } | null>}
 *   null when the shop has no active version: the advisor keeps its playbooks
 */
export async function loadAdvisorKnowledge(db, shopId) {
  const rows = await db.selectAll(ADVISOR_T.KNOWLEDGE, { shop_id: shopId, status: 'active' }, 'version,products,routines');
  const row = rows?.[0];
  if (!row || !Array.isArray(row.products) || !row.routines?.foundations?.length) return null;
  return { version: row.version, knowledge: knowledgeIndex(row.products), routines: row.routines };
}

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { parseKnowledgeRows } from '../lib/advisory/product-knowledge.mjs';
import { parseRoutineRows, parseRuleRows } from '../lib/advisory/routine-knowledge.mjs';

// Imports the brand's knowledge spreadsheet (Products, Routines, Rules) into a
// JSON file in git (docs/storefront-advisor-plan.md § 2).
//
//   npm run advisor:import -- --check      read and check, write nothing
//   npm run advisor:import                 write the JSON next to the spreadsheet
//   npm run advisor:import -- --file data/advisor/x.xlsx --out data/advisor/x.json
//
// THE SPREADSHEET IS THE MASTER. The JSON is its transcription, every cell as
// typed, so each correction is a reviewable diff; the rules (product-knowledge,
// routine-knowledge) apply when it is read, and this report says what they keep:
// rows approved, rows still « À valider », rows rejected and why, with their line
// in the spreadsheet. Nothing reaches the advisor or the database from here.

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const file = flag('--file') ?? 'data/advisor/qiriness-knowledge-template.xlsx';
const out = flag('--out') ?? file.replace(/-template\.xlsx$|\.xlsx$/, '.json');
const check = args.includes('--check');

const python = process.platform === 'win32' ? 'python' : 'python3';
const read = spawnSync(python, [path.join('scripts', 'advisor', 'export-knowledge-sheet.py'), file], { encoding: 'utf8', maxBuffer: 64 << 20 });
if (read.status !== 0) {
  console.error(read.stderr || read.error?.message || 'could not read the spreadsheet');
  if (/openpyxl/.test(read.stderr ?? '')) console.error(`Install the reader once: ${python} -m pip install openpyxl`);
  process.exit(1);
}
const sheet = JSON.parse(read.stdout);

const rules = parseRuleRows(sheet.rules);
const routines = parseRoutineRows(sheet.routines, rules);
const products = parseKnowledgeRows(sheet.products, { concerns: rules.concerns });

const rowOf = new Map(sheet.products.map((r) => [r.handle, r._row]));
const pending = products.skipped.filter((s) => s.status !== 'Exemple');
const rejected = new Set(products.errors.map((e) => e.handle));
const byStatus = (s) => products.products.filter((p) => p.status === s).length;

console.log(`${file}\n`);
console.log(`Products  ${sheet.products.filter((r) => r.status !== 'Exemple').length} rows`);
console.log(`  advised          ${byStatus('validated') + byStatus('corrected')}  (« Validé » ${byStatus('validated')}, « Corrigé » ${byStatus('corrected')})`);
console.log(`  never advised    ${byStatus('do_not_advise')}  (« Ne pas conseiller »)`);
console.log(`  not yet approved ${pending.length}  (« À valider »: skipped)`);
console.log(`  rejected         ${rejected.size}`);
for (const e of products.errors) console.log(`    row ${rowOf.get(e.handle) ?? '?'}  ${e.handle}  ${e.field} = ${e.value}`);

// Read with every row approved: what Qiriness's validation would still trip on.
const ifApproved = parseKnowledgeRows(sheet.products.map((r) => (r.status === 'À valider' ? { ...r, status: 'Validé' } : r)), { concerns: rules.concerns });
const latent = ifApproved.errors.filter((e) => !rejected.has(e.handle));
if (latent.length) {
  console.log(`  once approved, rejected: ${new Set(latent.map((e) => e.handle)).size}`);
  for (const e of latent) console.log(`    row ${rowOf.get(e.handle) ?? '?'}  ${e.handle}  ${e.field} = ${e.value}`);
}

console.log(`\nRoutines  day ${routines.steps.day.length} steps, night ${routines.steps.night.length}, ${routines.modules.length} modules`);
const stepLine = (part, s) => `  ${part.padEnd(5)} ${s.order} ${s.types.join(' or ').padEnd(18)} ${s.area.padEnd(5)} by ${s.chosen_by.join(', ')}${s.product ? ` · ${s.product}` : ''}${s.concern_required ? ' (empty if nothing for the concern)' : ''}`;
for (const part of ['day', 'night']) for (const s of routines.steps[part]) console.log(stepLine(part, s));
for (const [main, parts] of Object.entries(routines.own_steps)) {
  console.log(`  main concern ${main}'s own steps:`);
  for (const part of ['day', 'night']) for (const s of parts[part]) console.log(stepLine(part, s));
}
for (const m of routines.modules) console.log(`  module ${m.name_fr}: ${m.type ?? '?'}${m.when.length ? ` (${m.when.join(', ')})` : ''}`);
console.log(`\nRules     ${rules.concerns.length} concerns; cream texture ${Object.entries(rules.skin_type_texture).map(([k, v]) => `${k} → ${v}`).join(', ')}`);
for (const f of routines.foundations) console.log(`  ${f.key} ${f.name_fr.padEnd(16)} ${(f.range_by_age ? 'range by age' : f.preferred_ranges[0] ?? 'no range').padEnd(14)} ${f.primary_concerns.join(', ')}`);
console.log(`  sensitive skin: ${rules.concerns.filter((c) => c.skin === 'sensitive').map((c) => c.key).join(', ') || '—'}`);
console.log(`  ages: ${rules.age_ranges.map((a) => `${a.key} → ${a.range}`).join(', ') || '—'}; moments: ${rules.routine_times.map((t) => t.key).join(', ') || '—'}`);

const errors = [...routines.errors.map((e) => ({ tab: 'Routines', ...e })), ...rules.errors.map((e) => ({ tab: 'Rules', ...e }))];
if (errors.length) console.log(`\nErrors (${errors.length})`);
for (const e of errors) console.log(`  ${e.tab} row ${e.row}  ${e.field} = ${e.value}`);
if (routines.warnings.length) console.log(`\nTo check (${routines.warnings.length})`);
for (const w of routines.warnings) console.log(`  ${w}`);

if (check) {
  console.log('\n--check: nothing written.');
} else {
  fs.writeFileSync(out, `${JSON.stringify({ _about: `Transcription of ${path.basename(file)} by npm run advisor:import. Do not edit: correct the spreadsheet and import again.`, ...sheet }, null, 1)}\n`);
  console.log(`\nWritten: ${out}`);
}
process.exitCode = errors.length || products.errors.length ? 1 : 0;

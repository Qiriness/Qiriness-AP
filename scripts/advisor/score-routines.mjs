import fs from 'node:fs';
import path from 'node:path';

import { createAdvisor } from '../lib/advisory/recommend.mjs';
import { knowledgeIndex, parseKnowledgeRows } from '../lib/advisory/product-knowledge.mjs';
import { ROUTINE_CASES } from '../lib/advisory/routine-cases.mjs';
import { createAdvisorTurn } from '../lib/storefront-chat/advisor-tools.mjs';
import { emptyAdvisorState } from '../lib/storefront-chat/advisor-state.mjs';

// THE ROUTINE BUILDER'S SCORECARD: the engine on the invented routines and
// catalogue (data/advisor/sample-routines/), against what each case should give
// (routine-cases.mjs). No model, no database: the deterministic part, the same
// path a chat turn takes (lexicon → profile → engine).
//
//   npm run advisor:score                  every case, French and English
//   npm run advisor:score -- --only owned  cases whose id contains « owned »
//   npm run advisor:score -- --json out.json
//   npm run advisor:score -- --engine playbooks   the old playbook engine, for comparison
//
// A failure says what the routine should have had. The failures are the list
// of what to optimise; the score is how far the engine is from the plan.

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const read = (p) => JSON.parse(fs.readFileSync(path.resolve(p), 'utf8'));

const CONFIG = read('data/advisor/qiriness.json');
const CATALOGUE = read('data/advisor/sample-routines/catalogue.json');
const SHEET = read('data/advisor/sample-routines/knowledge.json');
const ROUTINES = read('data/advisor/sample-routines/routines.json');
const KNOWLEDGE = knowledgeIndex(parseKnowledgeRows(SHEET.rows, { concerns: SHEET.concerns }).products);
// The foundation engine (plan § 3.1–3.4); --engine playbooks scores the old one, to compare.
const playbooks = args.includes('--engine') && flag('--engine') === 'playbooks';
const advisor = createAdvisor(CONFIG, CATALOGUE, { knowledge: KNOWLEDGE, routines: playbooks ? null : ROUTINES });
const byId = new Map(CATALOGUE.products.map((p) => [p.id, p]));
const byHandle = new Map(CATALOGUE.products.map((p) => [p.handle, p]));
const money = (n) => `${n} €`;
// The builder's own questions answered, so a builder case is scored on its routine.
const BUILDER_ASKED = ['skin_type', 'sensitivity', 'current_routine', 'routine_scope', 'age_band'];

const knowledgeOf = (id) => KNOWLEDGE.get(byId.get(id)?.handle) ?? null;
const concernsOf = (k) => (k ? [k.primary_concern, ...k.other_concerns].filter(Boolean) : []);

function run(c) {
  const state = c.builder ? { ...emptyAdvisorState(), asked: BUILDER_ASKED } : c.previous ? { ...emptyAdvisorState(), last_advice: { status: 'recommended', playbook: null, scope: 'targeted', product_ids: [byHandle.get(c.previous).id] } } : null;
  const turn = createAdvisorTurn({
    advisor, state, message: c.message, action: c.builder ? 'build_routine' : null, locale: c.lang, catalogue: CATALOGUE, money,
    consultation: true, stillUsing: (c.owned ?? []).map((h) => byHandle.get(h)?.id).filter(Boolean),
  });
  const advice = turn.opening();
  const steps = (advice?.steps ?? []).map((s) => ({ ...s, knowledge: knowledgeOf(s.product_id) }));
  const treat = advice?.status === 'recommended' ? advisor.treat({ profile: turn.profile, exclude: steps.map((s) => s.product_id) }) : null;
  return { advice, steps, treat, profile: turn.profile, mode: turn.mode };
}

function judge(c, r) {
  const e = c.expect;
  const fails = [];
  const types = r.steps.map((s) => s.knowledge?.functional_type ?? '?');
  const foundation = r.advice?.playbook?.key ? ROUTINES.engine_playbooks[r.advice.playbook.key] ?? r.advice.playbook.key : 'none';
  const shown = r.steps.flatMap((s) => [s.product_id, ...s.alternatives.map((a) => a.product_id)]).map((id) => byId.get(id)?.handle);

  if (e.status && r.advice?.status !== e.status) fails.push(`status ${r.advice?.status ?? 'not run'}, expected ${e.status}${r.advice?.next_question ? ` (asks ${r.advice.next_question.field})` : r.advice?.reason ? ` (${r.advice.reason})` : ''}`);
  if (e.foundation && !e.foundation.includes(foundation)) fails.push(`foundation ${foundation}, expected ${e.foundation.join(' or ')}`);
  if (e.steps && (r.steps.length < e.steps[0] || r.steps.length > e.steps[1])) fails.push(`${r.steps.length} products, expected ${e.steps[0]}–${e.steps[1]}`);
  for (const t of e.types ?? []) if (!types.includes(t)) fails.push(`no ${t} step`);
  for (const t of e.no_types ?? []) if (types.includes(t)) fails.push(`a ${t} step it should not have`);
  for (const t of e.targets ?? []) {
    const step = r.steps.find((s) => s.knowledge?.functional_type === t.type);
    if (step && !concernsOf(step.knowledge).some((k) => t.any.includes(k))) fails.push(`the ${t.type} targets ${concernsOf(step.knowledge).join('+') || 'nothing'}, expected ${t.any.join(' or ')}`);
  }
  if (e.texture) {
    const step = r.steps.find((s) => s.knowledge?.functional_type === e.texture.type);
    if (step && step.knowledge?.texture !== e.texture.is) fails.push(`the ${e.texture.type} is ${step.knowledge?.texture ?? 'unknown'}, expected ${e.texture.is}`);
  }
  if (e.every === 'sensitive_ok') for (const s of r.steps) if (s.knowledge?.sensitive === 'avoid') fails.push(`${s.handle} is not for sensitive skin`);
  if (e.every === 'not_premium') for (const s of r.steps) if (s.knowledge?.premium) fails.push(`${s.handle} is premium without a reason`);
  if (e.every === 'men_first') for (const s of r.steps) {
    const menExists = CATALOGUE.products.some((p) => KNOWLEDGE.get(p.handle)?.men && KNOWLEDGE.get(p.handle)?.functional_type === s.knowledge?.functional_type);
    if (menExists && !s.knowledge?.men) fails.push(`the ${s.knowledge?.functional_type} is not the men's one`);
  }
  for (const h of e.no_handles ?? []) if (shown.includes(h)) fails.push(`shows ${h}`);
  if (e.kit_first && !(r.steps[0] && (['coffret', 'kit'].includes(r.steps[0].knowledge?.functional_type) || r.steps[0].knowledge?.gift))) fails.push(`first product ${r.steps[0]?.handle ?? 'none'}, expected a gift set`);
  if (e.no_treat && r.treat) fails.push(`offers a treat (${byId.get(r.treat.product_id)?.handle})`);
  const total = r.steps.reduce((n, s) => n + (byId.get(s.product_id)?.priceFrom ?? 0), 0);
  if (e.max_total !== undefined && total > e.max_total) fails.push(`costs ${total}, expected at most ${e.max_total}`);
  if (e.dropped && !(r.advice?.skipped ?? []).filter((s) => s.reason === 'over_budget').length) fails.push('nothing left out for the budget');
  const shownCount = r.steps.reduce((n, s) => n + 1 + (s.top_choices ? s.alternatives.length : 0), 0);
  if (e.choices && (shownCount < e.choices[0] || shownCount > e.choices[1])) fails.push(`${shownCount} products shown, expected ${e.choices[0]}–${e.choices[1]}`);
  return { fails, foundation, types };
}

const only = flag('--only');
const results = [];
for (const c of ROUTINE_CASES) {
  if (only && !c.id.includes(only)) continue;
  const r = run(c);
  const { fails, foundation, types } = judge(c, r);
  results.push({ id: c.id, pass: !fails.length, fails, foundation, mode: r.mode, types, handles: r.steps.map((s) => s.handle) });
}

const width = Math.max(...results.map((r) => r.id.length));
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(width)}  ${r.foundation.padEnd(5)} ${r.types.join(' · ') || '—'}`);
  for (const f of r.fails) console.log(`${' '.repeat(width + 8)}✗ ${f}`);
}
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} cases pass (${Math.round((100 * passed) / Math.max(1, results.length))} %).`);
if (flag('--json')) fs.writeFileSync(path.resolve(flag('--json')), `${JSON.stringify({ at: new Date().toISOString(), passed, total: results.length, results }, null, 2)}\n`);

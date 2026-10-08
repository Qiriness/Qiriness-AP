import fs from 'node:fs';

import { loadConfig, loadEnv } from './lib/sync-config.mjs';
import { createSupabaseClient, supabaseSelect, supabaseSelectAll } from './lib/supabase-rest-client.mjs';
import { loadCatalogue } from './lib/storefront-chat/product-repository.mjs';
import { createAdvisor } from './lib/advisory/recommend.mjs';
import { loadAdvisoryConfig } from './lib/advisory/advisory-repository.mjs';
import { mergeProfile } from './lib/advisory/profile.mjs';
import { createAdvisorTurn } from './lib/storefront-chat/advisor-tools.mjs';
import { ADVISORY_CASES } from './lib/advisory/advisory-cases.mjs';

// The beauty consultation engine against the LIVE catalogue.
//
//   npm run eval:advisory                 the cases + the rule invariants, failures listed
//   npm run eval:advisory -- --all        every case printed with its routine
//   npm run eval:advisory -- --from-db    the config loaded in the advisor tables, not the file
//
// FREE: one catalogue read, no model. The bar: every case passes and the
// invariants — one per rule the brand set (stock, area, target, age, texture,
// current routine) — have ZERO violations over every concern × skin type ×
// sensitivity × target × scope × age × routine combination.

const verbose = process.argv.includes('--all');
const env = loadEnv();
const db = createSupabaseClient(loadConfig(env));
const reader = { selectAll: (t, f, c) => supabaseSelectAll(db, t, f, c) };
const [shop] = await supabaseSelect(db, 'shops', { shop_domain: env.SHOPIFY_STORE_DOMAIN }, 'id');
const catalogue = await loadCatalogue(reader, shop.id);
const raw = process.argv.includes('--from-db')
  ? await loadAdvisoryConfig(reader, shop.id)
  : JSON.parse(fs.readFileSync('data/advisor/qiriness.json', 'utf8'));
if (!raw) throw new Error('no advisory config in the database: run npm run advisor:load first');

const advisor = createAdvisor(raw, catalogue);
const nameOf = new Map(catalogue.products.map((p) => [p.id, p.name]));
const sigOf = new Map(advisor.signals.map((s) => [s.id, s]));
const money = (n) => `${n} €`;

console.log(`catalogue: ${catalogue.products.length} products · ${raw.playbooks.length} playbooks\n`);

// ---------------------------------------------------------------- cases
let failed = 0;
for (const c of ADVISORY_CASES) {
  let state = null;
  let turn = null;
  for (const t of c.turns) {
    const input = typeof t === 'string' ? { message: t } : { message: t.message ?? t.choice ?? '', choice: t.choice ?? null, action: t.action ?? null };
    turn = createAdvisorTurn({ advisor, state, catalogue, money, ...input });
    turn.opening();
    state = turn.nextState();
  }
  const a = turn.advice;
  const problems = [];
  const e = c.expect;
  const steps = a?.steps ?? [];
  if (e.playbook && a?.playbook?.key !== e.playbook) problems.push(`playbook ${a?.playbook?.key ?? '-'} ≠ ${e.playbook}`);
  if (e.status && a?.status !== e.status) problems.push(`status ${a?.status} ≠ ${e.status}`);
  if ('question' in e && (a?.next_question?.field ?? null) !== e.question) problems.push(`question ${a?.next_question?.field ?? 'none'} ≠ ${e.question ?? 'none'}`);
  if (e.notQuestion && a?.next_question?.field === e.notQuestion) problems.push(`asked ${e.notQuestion} again`);
  for (const o of e.options ?? []) if (!a?.next_question?.options.some((x) => x.value === o)) problems.push(`option ${o} missing`);
  (e.products ?? []).forEach((re, i) => { if (!re.test(nameOf.get(steps[i]?.product_id) ?? '')) problems.push(`step ${i + 1} « ${nameOf.get(steps[i]?.product_id) ?? 'none'} » ≠ ${re}`); });
  for (const re of e.not ?? []) for (const s of steps) if (re.test(nameOf.get(s.product_id))) problems.push(`« ${nameOf.get(s.product_id)} » matches ${re}`);
  for (const slot of e.notSlots ?? []) if (steps.some((s) => s.kind === slot)) problems.push(`recommended a ${slot} already in the routine`);
  for (const [field, value] of Object.entries(e.profile ?? {})) if (JSON.stringify(turn.profile[field]?.value) !== JSON.stringify(value)) problems.push(`profile.${field} ${JSON.stringify(turn.profile[field]?.value)} ≠ ${JSON.stringify(value)}`);
  if (problems.length) failed += 1;
  if (problems.length || verbose) {
    console.log(`${problems.length ? '✗' : '✓'} ${c.name}`);
    console.log(`    ${a?.status} ${a?.playbook?.key ?? '-'} ${a?.next_question ? `Q ${a.next_question.field}: ${a.next_question.options.map((o) => o.label).join(' | ')}` : ''}`);
    for (const s of steps) console.log(`    - ${s.slot}: ${nameOf.get(s.product_id)} [${s.reason_codes.join(', ')}]`);
    for (const p of problems) console.log(`    ! ${p}`);
  }
}
console.log(`\ncases: ${ADVISORY_CASES.length - failed}/${ADVISORY_CASES.length} pass`);

// ---------------------------------------------------------------- invariants
const violations = new Map();
const violate = (rule, detail) => {
  const list = violations.get(rule) ?? [];
  if (list.length < 5) list.push(detail);
  violations.set(rule, list);
};
const concerns = advisor.config.vocabulary.concernKeys;
const grid = [];
for (const concern of concerns) for (const skin of [null, 'dry', 'oily']) for (const sens of [null, 'sensitive']) for (const men of [false, true])
  for (const scope of ['targeted', 'complete']) for (const age of [null, '60_plus']) for (const current of [[], ['cleanser', 'moisturiser']]) {
    const updates = [{ field: 'primary_concern', value: concern }, { field: 'routine_scope', value: scope }];
    if (skin) updates.push({ field: 'skin_type', value: skin });
    if (sens) updates.push({ field: 'sensitivity', value: sens });
    if (men) updates.push({ field: 'sex_target', value: 'men' });
    if (age) updates.push({ field: 'age_band', value: age });
    for (const k of current) updates.push({ field: 'current_routine', value: k });
    grid.push(mergeProfile({}, updates.map((u) => ({ ...u, source: 'quick_choice' })), { allowed: advisor.allowed }).profile);
  }

const started = performance.now();
let recommended = 0;
for (const profile of grid) {
  const a = advisor.advise({ profile });
  if (a.status !== 'recommended') continue;
  recommended += 1;
  const men = profile.sex_target?.value === 'men';
  for (const s of a.steps) {
    const sig = sigOf.get(s.product_id);
    const where = `${profile.primary_concern.value}/${s.slot}: ${nameOf.get(s.product_id)}`;
    if (!sig.inStock) violate('2 stock', where);
    const area = raw.slots[s.slot]?.area ?? a.area;
    if (!sig.areas.has(area)) violate('3 area', `${where} (wanted ${area})`);
    if (men !== sig.men) violate(men ? '4 men → men\'s catalogue' : '5 unknown → main catalogue', where);
    if ((profile.current_routine?.value ?? []).includes(s.kind)) violate('9 current routine', where);
    const wanted = s.reason_codes.find((r) => r.startsWith('texture_mismatch'));
    if (wanted && (raw.textures[wanted.split(':')[1]]?.opposite)) violate('8 texture', `${where} ${wanted}`);
    if (s.merchandised && s.scores.suitability < 0) violate('10 merchandising on unsuitable', where);
  }
  if (profile.age_band) {
    const { age_band, ...ageless } = profile;
    const b = advisor.advise({ profile: ageless });
    if (b.playbook?.key !== a.playbook?.key) violate('6 age selects a playbook', `${profile.primary_concern.value}: ${b.playbook?.key} → ${a.playbook?.key}`);
  }
}
const ms = performance.now() - started;
console.log(`\ninvariants over ${grid.length} profiles (${recommended} recommended, ${(ms / grid.length).toFixed(2)} ms each):`);
if (!violations.size) console.log('  0 violations');
for (const [rule, list] of violations) console.log(`  ✗ rule ${rule}:\n      ${list.join('\n      ')}`);
process.exitCode = failed || violations.size ? 1 : 0;

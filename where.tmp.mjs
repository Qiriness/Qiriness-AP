import { readFileSync } from 'node:fs';

import { answerSetFor } from './agent/src/investigation/investigation-rules.mjs';
import { findingValues } from './agent/src/investigation/evidence-rules.mjs';

const env = {};
for (const line of readFileSync('./.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const headers = { apikey: env.SUPABASE_SECRET_KEY };
const q = async (p) =>
  JSON.parse(await (await fetch(`${env.SUPABASE_URL}/rest/v1/${p}`, { headers, cache: 'no-store' })).text());

const answers = await q('support_answers?select=answer_set,answer_key,situation_key,route,ask,approval_status&order=answer_set,answer_key');
const exemplars = await q('support_exemplars?select=exemplar_key,category,demand_message_count&deleted_at=is.null&order=exemplar_key');

const bySet = {};
for (const a of answers) (bySet[a.answer_set] ??= []).push(a);

console.log('RULES — support_answers\n');
for (const [set, list] of Object.entries(bySet)) {
  console.log(`  ${set}: ${list.length} rules (${[...new Set(list.map((r) => r.approval_status))].join(', ')})`);
}

const families = {};
for (const e of exemplars) {
  const set = answerSetFor(e.category) ?? '(no family)';
  (families[set] ??= []).push(e);
}

console.log('\nSITUATIONS by family, and whether rules exist\n');
for (const [set, list] of Object.entries(families).sort((a, b) => b[1].length - a[1].length)) {
  const demand = list.reduce((s, e) => s + (e.demand_message_count ?? 0), 0);
  const rules = bySet[set]?.length ?? 0;
  console.log(
    `  ${String(set).padEnd(12)} ${String(list.length).padStart(2)} situations · ${String(demand).padStart(3)} messages · ${rules} rules`
  );
  console.log(`     ${list.map((e) => e.exemplar_key).join(' ')}`);
}

console.log('\nSTATES a rule can branch on today\n');
for (const need of [
  'order_state',
  'delivery_state',
  'payment_state',
  'photo_evidence',
  'purchase_verified',
  'promotion_validity',
  'promotion_eligibility',
  'product_identity',
  'product_availability',
  'policy_answer',
  'customer_identity',
  'return_eligibility',
  'refund_state'
]) {
  const values = findingValues(need);
  console.log(`  ${need.padEnd(22)} ${values ? values.join(' · ') : 'NO FINDINGS — nothing can branch on it'}`);
}

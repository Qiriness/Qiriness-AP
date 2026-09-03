// ONE-OFF — delete after the re-run.
//
// Picks a stratified sample, snapshots what its case files say TODAY, and raises
// the investigation flag so `--include-closed` can claim them.
//
// THE SNAPSHOT IS THE POINT. `saveCaseFile` upserts on (shop, trigger_message),
// so re-investigating replaces the row and the old verdict is gone. Without this
// the re-run measures the new state against nothing.
//
// STRATIFIED, NOT OLDEST-FIRST. The queue is oldest-first over a historical
// corpus, and 50 tickets taken that way would be mostly delivery. What is being
// measured is a rules layer that differs per subject, so the sample has to carry
// every subject in roughly the proportion the corpus holds.

import { writeFileSync } from 'node:fs';

import { loadConfig, loadEnv } from './lib/sync-config.mjs';
import { createSupabaseClient, supabaseSelectAll, supabaseUpdate } from './lib/supabase-rest-client.mjs';
import { ENABLED_SUBJECTS } from '../agent/src/investigation/investigation-rules.mjs';

const SIZE = Number(process.argv[2] || 50);
const OUT = process.argv[3] || 'tmp-rerun-before.json';

const supabase = createSupabaseClient(loadConfig(loadEnv()));

const tickets = (await supabaseSelectAll(supabase, 'tickets', {}, 'id,status,category,level,subject,needs_categorisation,archived_at,deleted_at,first_message_at'))
  .filter(
    (t) =>
      !t.archived_at &&
      !t.deleted_at &&
      t.needs_categorisation === false &&
      ENABLED_SUBJECTS.includes(t.category) &&
      (t.level ?? 1) < 4
  );

// Proportional per subject, newest first inside each — recent mail is the mail
// the rules were written against.
const bySubject = new Map();
for (const t of tickets) {
  if (!bySubject.has(t.category)) bySubject.set(t.category, []);
  bySubject.get(t.category).push(t);
}
const picked = [];
for (const [, list] of bySubject) {
  list.sort((a, b) => String(b.first_message_at).localeCompare(String(a.first_message_at)));
  const share = Math.max(1, Math.round((list.length / tickets.length) * SIZE));
  picked.push(...list.slice(0, share));
}
const sample = picked.slice(0, SIZE);

const investigations = await supabaseSelectAll(
  supabase,
  'ticket_investigations',
  {},
  'ticket_id,verdict,exemplar_match,evidence_gaps,tool_calls,investigated_at'
);
const byTicket = new Map(investigations.map((i) => [i.ticket_id, i]));

const before = sample.map((t) => {
  const inv = byTicket.get(t.id) || null;
  const policy = inv?.exemplar_match?.policy || null;
  return {
    ticketId: t.id,
    category: t.category,
    status: t.status,
    subject: t.subject,
    investigatedAt: inv?.investigated_at ?? null,
    verdict: inv?.verdict ?? null,
    exemplarVerdict: inv?.exemplar_match?.verdict ?? null,
    exemplarKey: inv?.exemplar_match?.exemplar_key ?? inv?.exemplar_match?.closest ?? null,
    ruleKey: policy?.answer_key ?? null,
    ruleApplied: policy?.applied === true,
    toolCalls: Array.isArray(inv?.tool_calls) ? inv.tool_calls.length : null,
    gapsOpen: (inv?.evidence_gaps || []).filter((g) => g.state !== 'satisfied').length
  };
});

writeFileSync(OUT, JSON.stringify(before, null, 1));

const counts = {};
for (const b of before) counts[b.category] = (counts[b.category] || 0) + 1;
console.log(`sample: ${before.length} tickets`);
console.log('  by subject:', JSON.stringify(counts));
console.log('  never investigated:', before.filter((b) => !b.investigatedAt).length);
console.log('  snapshot written to', OUT);

// Raise the flag. `--include-closed` drops the status narrowing and nothing
// else, so without this the claim finds none of them.
const ids = before.map((b) => b.ticketId);
for (const id of ids) {
  await supabaseUpdate(supabase, 'tickets', { id }, { needs_investigation: true });
}
console.log(`  flagged ${ids.length} ticket(s) for investigation`);

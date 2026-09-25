import { createSupabaseClient, supabaseSelect } from '../../scripts/lib/supabase-rest-client.mjs';
import { COLUMNS, T } from '../../scripts/lib/tables.mjs';

import { loadAgentConfig } from '../src/config.mjs';
import { resolveShopId } from '../src/lib/shop.mjs';
import { caseDeltaFrom } from '../src/investigation/case-delta.mjs';

import { ranWithDelta, scoreDeltaRun } from './score-delta.mjs';

// What follow-up investigations did with the case delta, from the stored rows.
//
//   npm run eval:delta
//   npm run eval:delta -- --show     # one line per run
//
// NO MODEL CALL AND NO WRITE. It reads `ticket_investigations` and
// `ticket_case_state` and rebuilds the delta each run was given — the same
// `caseDeltaFrom` the runner calls, over the same reading — so the report
// cannot drift from what the prompt said.
//
// THE BASELINE IS THE FOLLOW-UPS THAT RAN WITHOUT ONE: investigations of a
// message after the first on a thread, with no reading about their trigger.
// Calls per run on each side is the headline; re-fetches and missed refreshes
// are what the headline could be hiding.

const show = process.argv.includes('--show');

const config = loadAgentConfig();
const supabase = createSupabaseClient(config);
const shopId = await resolveShopId(supabase, config.shopDomain);

const investigations = await supabaseSelect(
  supabase,
  T.TICKET_INVESTIGATIONS,
  { shop_id: shopId },
  'ticket_id,trigger_message_id,tool_calls,investigated_at',
  { order: 'investigated_at.asc' }
);
const readings = await supabaseSelect(supabase, T.TICKET_CASE_STATE, { shop_id: shopId }, COLUMNS.caseStateForInvestigation);
const readingFor = new Map(readings.map((row) => [row.trigger_message_id, row]));

// A follow-up is a run whose ticket already had an earlier run.
const seenTicket = new Set();
const withDelta = [];
const without = [];
for (const investigation of investigations) {
  const followUp = seenTicket.has(investigation.ticket_id);
  seenTicket.add(investigation.ticket_id);
  if (!followUp) continue;

  const reading = readingFor.get(investigation.trigger_message_id) ?? null;
  const delta = ranWithDelta({ investigation, reading })
    ? caseDeltaFrom({ reading, triggerMessageId: investigation.trigger_message_id })
    : null;
  const scored = scoreDeltaRun({ delta, toolCalls: investigation.tool_calls });
  (delta ? withDelta : without).push({ investigation, delta, scored });
}

const mean = (rows) => (rows.length ? (rows.reduce((sum, r) => sum + r.scored.calls, 0) / rows.length).toFixed(2) : '—');
const count = (rows, field) => rows.filter((r) => r.scored[field].length > 0).length;

console.log(`\nSuivis enquêtés : ${withDelta.length + without.length}`);
console.log(`  avec dossier connu    ${String(withDelta.length).padStart(4)} · ${mean(withDelta)} appels/enquête`);
console.log(`  sans dossier connu    ${String(without.length).padStart(4)} · ${mean(without)} appels/enquête`);
if (withDelta.length > 0) {
  console.log(`  re-vérifié un fait établi (modèle) : ${count(withDelta, 'refetchedEstablished')} / ${withDelta.length}`);
  console.log(`  fait à revérifier resté non revu    : ${count(withDelta, 'staleMissed')} / ${withDelta.length}`);
} else {
  console.log('  Aucune enquête n’a encore reçu de dossier connu : il en faut une lecture du Case Manager sur le même message.');
}

if (show) {
  for (const { investigation, scored } of withDelta) {
    console.log(
      `  ${investigation.ticket_id.slice(0, 8)} ${scored.calls} appel(s) ${JSON.stringify(scored.bySource)}` +
        (scored.refetchedEstablished.length ? ` · re-vérifié : ${scored.refetchedEstablished.join(', ')}` : '') +
        (scored.staleMissed.length ? ` · non revu : ${scored.staleMissed.join(', ')}` : '')
    );
  }
}

import { pathToFileURL } from 'node:url';

import { loadConfig, loadEnv } from './lib/sync-config.mjs';
import { createSupabaseClient, supabaseSelectAll } from './lib/supabase-rest-client.mjs';
import { normaliseConditions } from '../agent/src/investigation/answer-selection.mjs';
import { proposeCollection } from '../agent/src/investigation/collection-planner.mjs';
import { allowedTools } from '../agent/src/investigation/investigation-rules.mjs';

// What rule-directed collection would collect, per situation, before switching
// one on.
//
//   npm run report:collection-planner
//   npm run report:collection-planner -- --situation D-02
//
// THE CHOOSER. `collection_mode` is a per-situation opt-in and defaults to
// `model`, so the planner does nothing until somebody decides where it should.
// This is how that decision is made on evidence: replay the planner over stored
// runs and print what it WOULD have proposed, per situation, with the tool and
// whether its arguments could be assembled at all.
//
// IT REPLAYS AGAINST STORED EVIDENCE, WHICH IS THE LIMIT WORTH STATING. The
// planner reads the ledger to chain arguments -- a promotion code comes from
// what `extractPromotionCodes` returned -- and `tool_calls` keeps `{id, tool,
// argsHash, outcome}` with `data` deliberately dropped. So a chained call reads
// here as unassemblable even where the live run could have made it. Every
// number below is therefore a FLOOR: the planner would propose at least this
// much, never less. `lookupPromotion` is the one tool affected.
//
// A SITUATION PROPOSING NOTHING IS NOT A FAILED SITUATION. It usually means the
// opening moves already establish what its rules branch on, which is the outcome
// to want -- there is nothing left to be inconsistent about.
//
// ZERO COST. Four reads, no writes, no model call.

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

async function main() {
  const supabase = createSupabaseClient(loadConfig(loadEnv()));
  const since = valueOf('--since');
  const onlySituation = valueOf('--situation');

  const answerRows = (
    await supabaseSelectAll(
      supabase,
      'support_answers',
      {},
      'answer_key,answer_set,situation_key,when_conditions,route,ask,priority,is_fallback,approval_status,deleted_at'
    )
  ).filter((row) => !row.deleted_at && row.approval_status === 'approved');

  const bySet = new Map();
  for (const row of answerRows) {
    if (!bySet.has(row.answer_set)) bySet.set(row.answer_set, []);
    bySet.get(row.answer_set).push({
      answerKey: row.answer_key,
      situationKey: row.situation_key ?? null,
      conditions: normaliseConditions(row.when_conditions),
      route: row.route ?? null,
      ask: Array.isArray(row.ask) ? row.ask : [],
      offerCode: null,
      priority: row.priority ?? 0,
      isFallback: Boolean(row.is_fallback)
    });
  }

  const tickets = await supabaseSelectAll(supabase, 'tickets', {}, 'id,category,request_kind,level');
  const byTicket = new Map(tickets.map((t) => [t.id, t]));
  const modes = new Map(
    (await supabaseSelectAll(supabase, 'support_exemplars', {}, 'exemplar_key,collection_mode,deleted_at'))
      .filter((row) => !row.deleted_at)
      .map((row) => [row.exemplar_key, row.collection_mode ?? 'model'])
  );

  const runs = (
    await supabaseSelectAll(
      supabase,
      'ticket_investigations',
      {},
      'ticket_id,evidence_gaps,tool_calls,exemplar_match,investigated_at'
    )
  ).filter((row) => {
    if (since && String(row.investigated_at ?? '') < since) return false;
    if (!row.exemplar_match?.policy) return false;
    const key = row.exemplar_match.policy.situation_key ?? row.exemplar_match.exemplar_key ?? null;
    return !onlySituation || key === onlySituation;
  });

  if (runs.length === 0) {
    console.log('\nNo stored runs carrying a policy in range.\n');
    return;
  }

  const perSituation = new Map();
  let proposing = 0;

  for (const row of runs) {
    const policy = row.exemplar_match.policy;
    const situation = policy.situation_key ?? '(no situation)';
    const answers = bySet.get(policy.answer_set) ?? [];
    const ticket = byTicket.get(row.ticket_id) ?? {};

    const proposal =
      answers.length === 0
        ? null
        : proposeCollection(answers, row.evidence_gaps ?? [], {
            situationKey: policy.situation_key ?? null,
            // The stored row keeps no message body. Only the semantic matchers
            // read it, and they are reported as such rather than silently
            // dropped -- see the floor note above.
            ticket: { text: '' },
            ledger: row.tool_calls ?? [],
            allowedTools: allowedTools(ticket.category, ticket.request_kind, ticket.level ?? 1)
          });

    if (!perSituation.has(situation)) {
      perSituation.set(situation, { runs: 0, proposals: new Map(), mode: modes.get(situation) ?? 'model' });
    }
    const entry = perSituation.get(situation);
    entry.runs += 1;
    const label = proposal ? `${proposal.need} via ${proposal.tool}` : 'nothing to collect';
    entry.proposals.set(label, (entry.proposals.get(label) ?? 0) + 1);
    if (proposal) proposing += 1;
  }

  console.log(`\nCOLLECTION PLANNER — ${runs.length} stored runs${since ? ` since ${since}` : ''}\n`);
  console.log(`  runs where the rules would propose a collection: ${proposing} of ${runs.length}\n`);

  const ordered = [...perSituation].sort((a, b) => {
    const aProposes = a[1].runs - (a[1].proposals.get('nothing to collect') ?? 0);
    const bProposes = b[1].runs - (b[1].proposals.get('nothing to collect') ?? 0);
    return bProposes - aProposes || b[1].runs - a[1].runs;
  });

  for (const [situation, entry] of ordered) {
    const idle = entry.proposals.get('nothing to collect') ?? 0;
    const active = entry.runs - idle;
    console.log(
      `  ${situation.padEnd(16)} ${String(entry.runs).padStart(3)} runs · ` +
        `${active} would collect · mode=${entry.mode}`
    );
    for (const [label, count] of [...entry.proposals].sort((a, b) => b[1] - a[1])) {
      if (label === 'nothing to collect' && active > 0) continue;
      console.log(`      ${String(count).padStart(3)} x ${label}`);
    }
  }

  console.log('\nA situation is worth opting in when it would collect something its');
  console.log('opening moves do not already establish. Set collection_mode in the rulebook.\n');
}

function valueOf(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function isDirectRun() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

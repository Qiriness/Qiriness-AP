import { pathToFileURL } from 'node:url';

import { loadConfig, loadEnv } from './lib/sync-config.mjs';
import { createSupabaseClient, supabaseSelectAll } from './lib/supabase-rest-client.mjs';
import { liveAnswers, normaliseConditions } from '../agent/src/investigation/answer-selection.mjs';
import { collectedFindings } from '../agent/src/investigation/collection-planner.mjs';
import { NEED_KEYS, resolveNeeds, responseComplete } from '../agent/src/investigation/evidence-rules.mjs';
import { allowedTools, openingMoves } from '../agent/src/investigation/investigation-rules.mjs';

// What suppression WOULD have cost, before any is switched on.
//
//   npm run report:collection-replay
//   npm run report:collection-replay -- --situation D-02
//
// THE GATE ON STEP 9. Suppression lets the loop stop early, and the one thing it
// must never do is drop a call an answer rested on. This replays every stored run
// that carries a `findings_trace`, finds the point at which BOTH stopping
// conditions first held, and reports what stopping there would have cost.
//
// WHY THE TRACE AND NOT `tool_calls`. Deciding whether the conditions held needs
// the findings AS THEY STOOD after each call, and 8 of the derivations read tool
// `data`, which `tool_calls` drops. Re-deriving from the ledger alone would score
// those findings absent, conclude the run knew less than it did, and stop it
// LATER -- flattering suppression by understating what it would have skipped.
// The trace is the only honest input, which is why it was built first.
//
// STATE COMES FROM THE LEDGER, FINDINGS FROM THE TRACE, and both are needed:
// `responseComplete` asks whether a need was ESTABLISHED, which is a question
// about which tools ran, while the rules ask what the value turned out to be.
//
// TWO CONDITIONS, NEVER ONE. Measured before this was written: on 58 of 90 runs
// the rule was already decided, and 50 of those still produced established facts
// -- 115 claims. A loop that stopped when the rule was decided would have dropped
// the collection behind them. That is the entire reason response needs exist.
//
// OPENING MOVES ARE NEVER SAVED. They run before the model speaks and are not up
// for negotiation, so the pool suppression draws from is what came after them.
//
// ZERO COST. Three reads, no writes, no model call.

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

async function main() {
  const supabase = createSupabaseClient(loadConfig(loadEnv()));
  const onlySituation = valueOf('--situation');

  const answerRows = (
    await supabaseSelectAll(
      supabase,
      'support_answers',
      {},
      'answer_key,answer_set,situation_key,when_conditions,priority,is_fallback,approval_status,deleted_at'
    )
  ).filter((row) => !row.deleted_at && row.approval_status === 'approved');

  const bySet = new Map();
  for (const row of answerRows) {
    if (!bySet.has(row.answer_set)) bySet.set(row.answer_set, []);
    bySet.get(row.answer_set).push({
      answerKey: row.answer_key,
      situationKey: row.situation_key ?? null,
      conditions: normaliseConditions(row.when_conditions),
      priority: row.priority ?? 0,
      isFallback: Boolean(row.is_fallback)
    });
  }

  const tickets = await supabaseSelectAll(supabase, 'tickets', {}, 'id,category,request_kind,level');
  const byTicket = new Map(tickets.map((t) => [t.id, t]));

  const runs = (
    await supabaseSelectAll(
      supabase,
      'ticket_investigations',
      {},
      'ticket_id,verdict,established,evidence_gaps,tool_calls,findings_trace,exemplar_match'
    )
  ).filter((row) => Array.isArray(row.findings_trace) && row.findings_trace.length > 0);

  if (runs.length === 0) {
    console.log('\nNo stored run carries a findings_trace. Re-investigate first — a trace is');
    console.log('written on every run from 2026-09-03, and cannot be filled in afterwards.\n');
    return;
  }

  const perSituation = new Map();
  for (const row of runs) {
    const ticket = byTicket.get(row.ticket_id);
    if (!ticket) continue;
    const situation = row.exemplar_match?.exemplar_key ?? '(no situation)';
    if (onlySituation && situation !== onlySituation) continue;

    const scored = replayRun(row, ticket, bySet);
    if (!perSituation.has(situation)) {
      perSituation.set(situation, { runs: 0, saved: 0, lost: 0, lostRuns: 0, gapRuns: 0, discretionary: 0 });
    }
    const acc = perSituation.get(situation);
    acc.runs += 1;
    acc.saved += scored.saved.length;
    acc.lost += scored.claimsLost;
    acc.discretionary += scored.discretionary;
    if (scored.claimsLost > 0) acc.lostRuns += 1;
    if (scored.shippedWithGap) acc.gapRuns += 1;
  }

  render(perSituation, runs.length);
}

/**
 * One run, replayed.
 *
 * Walks the ledger in call order and asks, BEFORE each call, whether both
 * stopping conditions already held. The first index where they do is where a
 * suppressing run would have stopped; everything from there on is saved.
 */
export function replayRun(row, ticket, bySet = new Map()) {
  const calls = row.tool_calls ?? [];
  const trace = row.findings_trace ?? [];
  const policy = row.exemplar_match?.policy ?? null;
  const answers = policy?.answer_set ? bySet.get(policy.answer_set) ?? [] : [];
  const names = allowedTools(ticket.category, ticket.request_kind, ticket.level ?? 1);

  // The floor, reconstructed the way `report-investigation-calls` does it: these
  // ran before the model spoke and are not suppressible.
  const floor = new Set(openingMoves({ ...ticket, text: '' }).map((move) => move.tool));
  const budget = new Map();
  for (const tool of floor) budget.set(tool, (budget.get(tool) ?? 0) + 1);

  const saved = [];
  let stopped = false;
  let discretionary = 0;

  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i];
    const left = budget.get(call.tool) ?? 0;
    const isOpeningMove = left > 0;
    if (isOpeningMove) budget.set(call.tool, left - 1);
    else discretionary += 1;

    if (!stopped && !isOpeningMove) {
      // The state of the world BEFORE this call: the ledger up to here, and the
      // trace snapshot from the previous call.
      const prefix = calls.slice(0, i);
      const resolved = resolvedAt(prefix, trace, i - 1, names);
      if (bothConditionsHold(answers, resolved, ticket, policy)) {
        stopped = true;
      }
    }

    if (stopped && !isOpeningMove) saved.push(call.id);
  }

  // THE NUMBER THAT DECIDES EVERYTHING: claims the case file rests on that cite a
  // call suppression would have skipped.
  const savedIds = new Set(saved);
  let claimsLost = 0;
  for (const claim of row.established ?? []) {
    const ids = claim?.evidence_ids ?? claim?.evidenceIds ?? [];
    if (ids.some((id) => savedIds.has(id))) claimsLost += 1;
  }

  return {
    saved,
    claimsLost,
    discretionary,
    // An `answerable` that would have stopped while a closable, mandatory gap was
    // still open. `gapClosability` decides "closable" — a gap nothing can ever
    // close is not a reason to keep collecting.
    shippedWithGap:
      stopped &&
      row.verdict === 'answerable' &&
      (row.evidence_gaps ?? []).some((gap) => gap.state === 'not_attempted')
  };
}

/** State from the ledger prefix, findings from the trace snapshot beside it. */
function resolvedAt(prefix, trace, traceIndex, names) {
  const resolved = resolveNeeds(NEED_KEYS, prefix, names);
  const snapshot = traceIndex >= 0 ? trace[traceIndex]?.findings ?? {} : {};
  return resolved.map((item) => ({
    ...item,
    finding: Object.prototype.hasOwnProperty.call(snapshot, item.need) ? snapshot[item.need] : item.finding
  }));
}

function bothConditionsHold(answers, resolved, ticket, policy) {
  // With no rules loaded there is no rule to be decided, so nothing may stop.
  if (answers.length === 0) return false;
  const decided =
    liveAnswers(answers, collectedFindings(resolved), { situationKey: policy?.situation_key ?? null }).length <= 1;
  return decided && responseComplete(ticket.category, resolved);
}

function render(perSituation, total) {
  console.log(`\nCOLLECTION REPLAY — ${total} runs carrying a findings_trace\n`);

  const rows = [...perSituation].sort((a, b) => b[1].lost - a[1].lost || b[1].saved - a[1].saved);
  const totals = { runs: 0, saved: 0, lost: 0, lostRuns: 0, gapRuns: 0, discretionary: 0 };
  for (const [, acc] of rows) for (const key of Object.keys(totals)) totals[key] += acc[key];

  console.log(`  discretionary calls in range     ${totals.discretionary}`);
  console.log(`  calls suppression would save     ${totals.saved}`);
  console.log(`  ESTABLISHED FACTS IT WOULD LOSE  ${totals.lost}  (across ${totals.lostRuns} runs)`);
  console.log(`  answerable stopped with a gap    ${totals.gapRuns}`);
  console.log('');
  console.log('  A situation is safe to suppress only where the middle number is 0.');
  console.log('  Reported per situation because that is the granularity it is enabled at —');
  console.log('  an average across situations is a number nobody can act on.\n');

  console.log(`  ${'situation'.padEnd(18)} ${'runs'.padStart(5)} ${'saved'.padStart(6)} ${'lost'.padStart(5)}  verdict`);
  for (const [situation, acc] of rows) {
    const safe = acc.lost === 0 && acc.gapRuns === 0;
    console.log(
      `  ${situation.padEnd(18)} ${String(acc.runs).padStart(5)} ${String(acc.saved).padStart(6)} ` +
        `${String(acc.lost).padStart(5)}  ${safe ? (acc.saved > 0 ? 'safe, and saves something' : 'safe, saves nothing') : 'DO NOT SUPPRESS'}`
    );
  }
  console.log('');
}

function valueOf(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function isDirectRun() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

import { pathToFileURL } from 'node:url';

import { loadConfig, loadEnv } from './lib/sync-config.mjs';
import { createSupabaseClient, supabaseSelectAll } from './lib/supabase-rest-client.mjs';
import { liveAnswers, normaliseConditions } from '../agent/src/investigation/answer-selection.mjs';
import {
  gapClosability,
  isMoot,
  needLabel,
  needsSatisfiedBy
} from '../agent/src/investigation/evidence-rules.mjs';

// What a completeness gate would do, before one is switched on.
//
//   npm run report:completeness-gate
//   npm run report:completeness-gate -- --since 2026-09-03
//   npm run report:completeness-gate -- --subject promotions
//
// THE GATE IS THE RULE that an `answerable` verdict may not stand while a fact
// the ticket needed is still open. This is that rule, computed over stored runs
// and printed, so the downgrades it would make can be READ before any of them
// happens to a customer.
//
// WHY REPORTED FIRST, AND IT IS NOT CAUTION FOR ITS OWN SAKE. `product_property`
// was derived wrong until 2026-08-31: of 13 product investigations reported
// unanswered, 8 were `satisfied` with a finding that said otherwise. A gate
// enforced over that bug would have converted 8 correct `answerable` verdicts
// into handovers. A gate is worth exactly as much as the derivations under it,
// and the vocabulary audit is what says whether those are sound today.
//
// WHAT THIS REPORT FOUND, AND IT CHANGES THE GATE'S DESIGN. The four-row table
// in the plan classifies a gap by WHO could close it and assumes somebody can.
// A third of the runs it would downgrade have nothing open but gaps NOBODY can
// ever close -- a need with no tool wired, the unsatisfiable-by-design escape
// hatch, or a finding the vocabulary declares as a permanent honest gap.
// Downgrading those sends a ticket to a person who can do no more about it than
// the agent could. `gapClosability` in `evidence-rules.mjs` is the fifth column
// the table needs.
//
// A FLOOR, NEVER A CEILING. Nothing here identifies a `needs_human` that should
// become `answerable`; a gate can only ever tighten, and a report of it can only
// ever list downgrades. That is the same asymmetry the policy route already has.
//
// `tool_errors_affecting_answer` IS ZERO ACROSS THE WHOLE CORPUS, and it is
// still counted. It is one of the four fields the gate is specified in terms of,
// a failing tool is the case where an `answerable` is least defensible, and a
// counter that reports nothing today is how you notice the first one.
//
// ZERO COST. Three reads, no writes, no model call.

const DEFAULTS = { examples: 12 };

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

async function main() {
  const supabase = createSupabaseClient(loadConfig(loadEnv()));
  const since = valueOf('--since');
  const onlySubject = valueOf('--subject');
  const examples = Number(valueOf('--examples') || DEFAULTS.examples);

  const investigations = await supabaseSelectAll(
    supabase,
    'ticket_investigations',
    {},
    'ticket_id,verdict,evidence_gaps,tool_calls,exemplar_match,investigated_at'
  );
  const tickets = await supabaseSelectAll(supabase, 'tickets', {}, 'id,category,subject');
  const answerRows = await supabaseSelectAll(
    supabase,
    'support_answers',
    {},
    'answer_key,answer_set,situation_key,when_conditions,route,priority,is_fallback,approval_status,deleted_at'
  );

  const byTicket = new Map(tickets.map((t) => [t.id, t]));
  // Approved only, exactly as `loadAnswers` reads them: a draft rule is not one
  // the agent could have been decided by, so counting it here would report a
  // decision the run never had available.
  const bySet = groupAnswers(answerRows);

  const runs = [];
  for (const row of investigations) {
    if (since && String(row.investigated_at ?? '') < since) continue;
    const ticket = byTicket.get(row.ticket_id);
    if (onlySubject && ticket?.category !== onlySubject) continue;
    // A run that declared nothing is not complete and not incomplete -- there is
    // no requirement to score it against. Excluded rather than counted either
    // way, which is the same call `summariseNeeds` makes with `declared > 0`.
    if ((row.evidence_gaps || []).length === 0) continue;
    runs.push(scoreRun(row, bySet, ticket));
  }

  if (runs.length === 0) {
    console.log('\nNo investigations with declared needs in range.\n');
    return;
  }

  render(runs, { since, onlySubject, examples });
}

/**
 * The four fields the gate is specified in terms of, for one stored run.
 *
 * PURE, and exported for that reason: every input is already on the row, so the
 * whole of this is testable without a database and the report itself is only
 * three reads and some printing.
 */
export function scoreRun(row, answersBySet = new Map(), ticket = null) {
  const gaps = row.evidence_gaps || [];
  // What the run established, as the gaps themselves recorded it. Read off the
  // row rather than re-derived: the point of this report is to score the gate
  // against what was ACTUALLY concluded, and a re-derivation here would be a
  // second opinion rather than a measurement.
  const findings = Object.fromEntries(
    gaps.filter((g) => g?.finding != null).map((g) => [g.need, g.finding])
  );

  // A moot need is not an open one. Its prerequisite resolved to a value that
  // makes the question meaningless -- looking up a promotion's eligibility when
  // the code does not exist -- and a gate that counted it would demand evidence
  // for a question nobody asked.
  const open = gaps
    .filter((g) => g?.state !== 'satisfied' && !isMoot(g.need, findings))
    .map((g) => ({ ...g, closability: gapClosability(g) }));

  const policy = row.exemplar_match?.policy ?? null;
  const set = policy?.answer_set ? answersBySet.get(policy.answer_set) : null;

  return {
    ticketId: row.ticket_id,
    subject: ticket?.category ?? '(unknown)',
    title: ticket?.subject ?? '(no subject)',
    verdict: row.verdict,
    situationKey: policy?.situation_key ?? row.exemplar_match?.exemplar_key ?? null,
    investigatedAt: row.investigated_at ?? null,

    responseComplete: open.length === 0,
    // `null` where no rule set loaded, and that is not the same as decided: a
    // ticket whose subject has no answer set never had a decision to complete.
    decisionComplete: set
      ? liveAnswers(set, policy?.findings || {}, { situationKey: policy?.situation_key ?? null }).length <= 1
      : null,
    mandatoryGaps: open,
    toolErrorsAffectingAnswer: erroredCallsAffecting(row.tool_calls || [], gaps)
  };
}

/**
 * Failing calls that could have settled something this ticket declared.
 *
 * NARROWED TO THE DECLARED NEEDS on purpose. `lookupStock` erroring on a
 * delivery ticket that never wanted availability is noise; the same error on a
 * stock question is the reason the answer is thin, and only the second belongs
 * in a gate.
 */
export function erroredCallsAffecting(toolCalls, gaps) {
  const declared = new Set(gaps.map((g) => g?.need));
  return toolCalls
    .filter((call) => call?.outcome === 'error')
    .filter((call) => needsSatisfiedBy(call.tool).some((need) => declared.has(need)))
    .map((call) => call.tool);
}

/**
 * How the gate would treat one run, given what could still close its gaps.
 *
 * `wrong` IS THE NUMBER THIS REPORT EXISTS FOR: every gap holding the verdict
 * open is one nothing can ever close, so the downgrade buys nothing and costs a
 * person's attention.
 */
export function gateVerdictFor(run) {
  if (run.verdict !== 'answerable') return 'not-a-downgrade';
  if (run.responseComplete && run.toolErrorsAffectingAnswer.length === 0) return 'stands';
  const kinds = run.mandatoryGaps.map((g) => g.closability);
  if (kinds.length > 0 && kinds.every((k) => k === 'never')) return 'wrong';
  return kinds.some((k) => k === 'never') ? 'mixed' : 'right';
}

function render(runs, { since, onlySubject, examples }) {
  const scope = [since ? `since ${since}` : null, onlySubject ? `subject ${onlySubject}` : null]
    .filter(Boolean)
    .join(', ');
  console.log(`\nCOMPLETENESS GATE — ${runs.length} runs with declared needs${scope ? ` (${scope})` : ''}\n`);

  const complete = runs.filter((r) => r.responseComplete).length;
  const decided = runs.filter((r) => r.decisionComplete === true).length;
  const undecided = runs.filter((r) => r.decisionComplete === false).length;
  const noSet = runs.filter((r) => r.decisionComplete === null).length;
  const errored = runs.filter((r) => r.toolErrorsAffectingAnswer.length > 0).length;

  console.log(`  response_complete             ${complete} of ${runs.length}`);
  console.log(`  decision_complete             ${decided} decided · ${undecided} still splitting · ${noSet} no rule set`);
  console.log(`  tool_errors_affecting_answer  ${errored}`);
  console.log('');

  const downgrades = runs.map((r) => [gateVerdictFor(r), r]).filter(([v]) => v !== 'not-a-downgrade' && v !== 'stands');
  const by = (kind) => downgrades.filter(([v]) => v === kind);

  console.log(`WHAT THE GATE WOULD DOWNGRADE — ${downgrades.length} answerable runs\n`);
  console.log(`  every open gap is actionable — the gate would be right   ${by('right').length}`);
  console.log(`  mixed: some gaps actionable, some unclosable             ${by('mixed').length}`);
  console.log(`  every open gap is unclosable — THE GATE WOULD BE WRONG   ${by('wrong').length}`);
  console.log('');
  console.log('  Read the last group before enforcing anything: those runs are handed to a');
  console.log('  person who can do no more about the gap than the agent could.\n');

  for (const kind of ['wrong', 'mixed', 'right']) {
    const list = by(kind);
    if (list.length === 0) continue;
    console.log(`  ${kind.toUpperCase()}`);
    for (const [, run] of list.slice(0, examples)) {
      console.log(
        `    [${run.subject}] ${run.situationKey ? run.situationKey + ' · ' : ''}${String(run.title).slice(0, 50)}`
      );
      for (const gap of run.mandatoryGaps) {
        console.log(
          `       ${gap.need} [${gap.state}/${gap.finding}] -> ${gap.closability}  — ${needLabel(gap.need)}`
        );
      }
    }
    if (list.length > examples) console.log(`    ... and ${list.length - examples} more`);
    console.log('');
  }

  // --- which needs do the blocking, across runs -------------------------------
  //
  // A need that blocks forty runs is a vocabulary problem wearing forty ticket
  // costumes, and the per-run list above cannot show that.
  const perNeed = new Map();
  for (const [, run] of downgrades) {
    for (const gap of run.mandatoryGaps) {
      const key = `${gap.need}|${gap.state}|${gap.closability}`;
      perNeed.set(key, (perNeed.get(key) ?? 0) + 1);
    }
  }
  console.log('WHICH NEEDS DO THE BLOCKING\n');
  for (const [key, count] of [...perNeed].sort((a, b) => b[1] - a[1])) {
    const [need, state, closability] = key.split('|');
    console.log(`  ${String(count).padStart(3)} x ${need} [${state}] -> ${closability}`);
  }
  console.log('');
}

/** Approved, undeleted answers per set, shaped the way `liveAnswers` reads them. */
function groupAnswers(rows) {
  const bySet = new Map();
  for (const row of rows) {
    if (row.deleted_at || row.approval_status !== 'approved') continue;
    if (!bySet.has(row.answer_set)) bySet.set(row.answer_set, []);
    bySet.get(row.answer_set).push({
      answerKey: row.answer_key,
      situationKey: row.situation_key ?? null,
      conditions: normaliseConditions(row.when_conditions),
      route: row.route ?? null,
      priority: row.priority ?? 0,
      isFallback: Boolean(row.is_fallback)
    });
  }
  return bySet;
}

function valueOf(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function isDirectRun() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

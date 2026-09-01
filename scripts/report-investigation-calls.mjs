import { loadConfig, loadEnv } from './lib/sync-config.mjs';
import { createSupabaseClient, supabaseSelectAll } from './lib/supabase-rest-client.mjs';
import { openingMoves } from '../agent/src/investigation/investigation-rules.mjs';

// How much of an investigation the MODEL chose, against how much was already
// decided before it spoke.
//
//   npm run report:investigation-calls
//   npm run report:investigation-calls -- --subject promotions
//
// WHY THIS IS THE FIRST MEASUREMENT BEFORE ANY RULE-GUIDED COLLECTION IS BUILT.
// Rule-directed collection can only improve on calls the model is choosing for
// itself; the deterministic opening moves are not up for negotiation and never
// will be. If the model typically chooses nothing — which is what
// `investigate.mjs` claims, "the model typically arrives with everything it
// needs and spends one turn writing the case file" — then a planner cannot save
// tool calls, and the case for building one is CONSISTENCY rather than cost.
// Those are different projects with different success measures, and the
// difference is worth one query.
//
// IT IS AN UPPER BOUND, AND SAYS SO. `tool_calls` keeps `{id, tool, argsHash,
// outcome}` — the ledger's `source` is dropped at persistence, so which calls
// were opening moves cannot be read back. It is RECONSTRUCTED by asking
// `openingMoves()` what this ticket's category would have opened with, and
// treating the rest as the model's.
//
// That reconstruction is wrong in exactly one direction: a decomposed ticket
// runs opening moves PER TASK (capped at 4), and the decomposition is not
// stored, so a two-task ticket's second set of moves is counted here as the
// model's. Every number below is therefore at or above the truth. That is the
// useful direction — if even the upper bound is near zero, there is no
// discretionary space to optimise and the question is settled.
//
// ZERO COST. Two reads, no writes, no model call.

const onlySubject = valueOf('--subject');
const examples = Number(valueOf('--examples') || 5);

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadConfig(loadEnv());
  const supabase = createSupabaseClient(config);

  const investigations = await supabaseSelectAll(
    supabase,
    'ticket_investigations',
    {},
    'ticket_id,tool_calls,verdict,investigated_at'
  );
  const tickets = await supabaseSelectAll(
    supabase,
    'tickets',
    {},
    'id,category,request_kind,level,subject'
  );
  const byId = new Map(tickets.map((t) => [t.id, t]));

  const rows = [];
  for (const run of investigations) {
    const ticket = byId.get(run.ticket_id);
    if (!ticket) continue;
    if (onlySubject && ticket.category !== onlySubject) continue;

    const calls = Array.isArray(run.tool_calls) ? run.tool_calls : [];
    // What this ticket would have opened with, as one task. `openingMoves` reads
    // category, kind and level and returns the tools; the arguments do not
    // matter here, only how many calls were foregone conclusions.
    const opening = openingMoves({
      category: ticket.category,
      request_kind: ticket.request_kind,
      level: ticket.level ?? 1,
      // A non-empty string so the semantic matchers are not filtered out by an
      // empty question — the text itself is never read here.
      text: '.'
    });
    const openingTools = new Set(opening.map((move) => move.tool));

    // TWO COUNTS, BECAUSE THEY BOUND THE ANSWER FROM BOTH SIDES.
    //
    // `beyondOpening` is total minus the opening budget: the upper bound
    // described above, which includes a decomposed ticket's extra moves.
    //
    // `newTools` counts calls to tools the opening set does not contain at all.
    // A second task's opening move usually IS such a tool, so this is not a
    // lower bound in the strict sense — but a call to a tool no opening move
    // could have made is the clearest evidence of the model reaching for
    // something, and it is the number a planner would have to beat.
    const beyondOpening = Math.max(0, calls.length - opening.length);
    const newTools = calls.filter((call) => !openingTools.has(call.tool)).length;

    rows.push({
      ticketId: run.ticket_id,
      subject: ticket.category || '(uncategorised)',
      title: ticket.subject || '(no subject)',
      verdict: run.verdict,
      total: calls.length,
      opening: opening.length,
      beyondOpening,
      newTools,
      tools: calls.map((c) => c.tool)
    });
  }

  if (rows.length === 0) {
    console.log('\nNo investigations recorded' + (onlySubject ? ` for ${onlySubject}` : '') + '.\n');
    return;
  }

  console.log('\nHOW MUCH OF AN INVESTIGATION THE MODEL CHOSE');
  console.log('Calls beyond the opening moves, per investigation. An UPPER BOUND —');
  console.log('a decomposed ticket\'s extra opening moves are counted as the model\'s.\n');

  report('ALL SUBJECTS', rows);

  const bySubject = new Map();
  for (const row of rows) {
    if (!bySubject.has(row.subject)) bySubject.set(row.subject, []);
    bySubject.get(row.subject).push(row);
  }
  for (const [subject, list] of [...bySubject].sort((a, b) => b[1].length - a[1].length)) {
    report(subject.toUpperCase(), list);
  }

  // The tickets where a planner would have had the most to do. Read these before
  // deciding the pilot set: if they are all one subject, that is the pilot.
  const busiest = rows.filter((r) => r.beyondOpening > 0).sort((a, b) => b.beyondOpening - a.beyondOpening);
  if (busiest.length > 0) {
    console.log('\nWHERE THE MODEL REACHED FURTHEST\n');
    for (const row of busiest.slice(0, examples)) {
      console.log(`  · [${row.subject}] +${row.beyondOpening} beyond opening — ${row.tools.join(' → ')}`);
      console.log(`      ${row.title}`);
    }
    if (busiest.length > examples) {
      console.log(`  … and ${busiest.length - examples} more (--examples to see further)`);
    }
  }

  console.log('');
}

/** One block of numbers for a set of investigations. */
function report(label, rows) {
  const total = rows.length;
  const beyond = rows.map((r) => r.beyondOpening).sort((a, b) => a - b);
  const chose = rows.filter((r) => r.beyondOpening > 0).length;
  const reached = rows.filter((r) => r.newTools > 0).length;

  console.log(`${label}  —  ${total} investigations`);
  console.log(`   median calls beyond opening : ${median(beyond)}`);
  console.log(`   p90                          : ${percentile(beyond, 0.9)}`);
  console.log(`   made ANY call beyond opening : ${chose} (${share(chose, total)}%)`);
  console.log(`   called a tool no opening move could : ${reached} (${share(reached, total)}%)`);
  console.log('');
}

const share = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

function median(sorted) {
  return percentile(sorted, 0.5);
}

/** Nearest-rank, on an already-sorted array. */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

function valueOf(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1];
}

import { loadConfig, loadEnv } from './lib/sync-config.mjs';
import { createSupabaseClient, supabaseSelectAll } from './lib/supabase-rest-client.mjs';
import {
  NEED_KEYS,
  findingValues,
  isDesignedGap,
  needLabel
} from '../agent/src/investigation/evidence-rules.mjs';

// Does the evidence vocabulary agree with itself?
//
//   npm run report:evidence-vocabulary
//   npm run report:evidence-vocabulary -- --need product_property
//
// WHAT THIS EXISTS TO ANSWER, AND WHY IT CANNOT WAIT. `evidence_gaps` is
// recorded and deliberately does not move the verdict — the reason given is that
// acting on it "depends on this vocabulary being trustworthy and nothing has yet
// measured whether it is". This is that measurement. Every plan that enforces a
// completeness gate, or lets rules direct collection, is standing on these
// derivations.
//
// NO LABELLED SET IS NEEDED, because the failure has an internal signature. Each
// gap entry carries TWO independent statements about the same need: `state`,
// computed from whether a tool in `satisfiedBy` returned a satisfying outcome,
// and `finding`, computed by that need's own `derive`. They read the same ledger
// by different routes, so where they contradict each other, one of them is
// wrong — and which cell it lands in says which.
//
// THIS IS THE SHAPE THE product_property BUG MADE. Of 13 product investigations
// reported unanswered, 8 were `state: satisfied` with `finding: none` — the tool
// had answered and the finding said the library was silent. It was found by
// reading rows. This turns that reading into a report that runs in a second.
//
// ZERO COST. Two reads, no writes, no model call.

const onlyNeed = valueOf('--need');
const examples = Number(valueOf('--examples') || 4);
// Rows are kept for ever and derivations change under them, so a contradiction
// from May says nothing about today. `--since` reads only investigations after a
// date; every group below also carries its most recent occurrence, which is the
// number that says whether a fault is live or history.
const since = valueOf('--since');

// Findings that mean "nothing was established". A need whose state says a tool
// satisfied it cannot honestly hold one of these.
//
// `undetermined` IS ONE OF THEM, and leaving it out was the first version's own
// false positive: it is `promotion_eligibility`'s honest "the tool could not
// decide, usually because the basket is invisible", and `satisfiedBy` excludes
// it deliberately so the gap is not laundered. `attempted` + `undetermined` is
// therefore the DESIGNED pairing, not a disagreement — it reported nine of them
// as faults on the first run.
const EMPTY_FINDINGS = new Set([
  'none',
  'not_found',
  'unknown',
  'undetermined',
  'no_product_named'
]);

// `<need>:<finding>` pairs where an empty-LOOKING value is a positive statement
// about the world rather than a failure to establish anything.
//
// `none` IS NOT ONE THING ACROSS THE VOCABULARY, and treating it as one produced
// this report's second false positive. `product_property: none` means the
// library held nothing — an absence of evidence, and a real disagreement when a
// tool satisfied the need. `refund_state: none` means THE ORDER HAS NO REFUND,
// which the order bundle established as firmly as it establishes a date. Same
// word, opposite epistemic status.
//
// Listed explicitly rather than inferred: whether absence is a finding or a gap
// is a property of what the tool was looking for, and only the person who wrote
// the vocabulary knows which.
const POSITIVE_ABSENCE = new Set(['refund_state:none']);

// The third false positive of the same family as the two above — "only a
// satisfied need may make a positive claim" is too strong a rule, because four
// needs deliberately score a value that says WHY they could not be settled — is
// `isDesignedGap`, imported rather than listed here.
//
// IT MOVED INTO THE VOCABULARY once the completeness gate needed the same fact:
// whether a finding is a legitimate statement about a failure is a property of
// what the tool was looking for, not of this report, and two readers now ask.

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
    'ticket_id,evidence_gaps,verdict,investigated_at'
  );
  const tickets = await supabaseSelectAll(supabase, 'tickets', {}, 'id,category,subject');
  const byId = new Map(tickets.map((t) => [t.id, t]));

  // need -> state -> finding -> count, plus the tickets behind each contradiction.
  const seen = new Map();
  const contradictions = [];
  let entries = 0;
  // Counted after `--since`, not before: printing the whole table's size beside a
  // filtered entry count reads as "4 entries across 93 runs", which is a ratio
  // nobody should draw.
  let runs = 0;

  for (const run of investigations) {
    if (since && String(run.investigated_at ?? '') < since) continue;
    runs += 1;
    const ticket = byId.get(run.ticket_id);
    for (const gap of run.evidence_gaps || []) {
      const need = gap?.need;
      if (!need || !NEED_KEYS.includes(need)) continue;
      if (onlyNeed && need !== onlyNeed) continue;
      entries += 1;

      const finding = gap.finding ?? '(null)';
      const state = gap.state ?? '(none)';
      if (!seen.has(need)) seen.set(need, new Map());
      const states = seen.get(need);
      if (!states.has(state)) states.set(state, new Map());
      const findings = states.get(state);
      findings.set(finding, (findings.get(finding) ?? 0) + 1);

      const kind = contradictionKind(state, gap.finding, need);
      if (kind) {
        contradictions.push({
          kind,
          need,
          state,
          finding,
          ticketId: run.ticket_id,
          at: run.investigated_at ?? null,
          subject: ticket?.category ?? '(unknown)',
          title: ticket?.subject ?? '(no subject)'
        });
      }
    }
  }

  if (entries === 0) {
    console.log('\nNo evidence gaps recorded' + (onlyNeed ? ` for ${onlyNeed}` : '') + '.\n');
    return;
  }

  console.log(
    `\nEVIDENCE VOCABULARY — ${entries} need entries across ${runs} investigations` +
      `${since ? ` since ${since}` : ''}\n`
  );

  // --- the contradictions, first, because they are the point ------------------
  if (contradictions.length === 0) {
    console.log('NO CONTRADICTIONS. `state` and `finding` agree on every entry.');
    console.log('That is the precondition for enforcing a completeness gate, not a proof');
    console.log('the findings are RIGHT — only that the two routes to them agree.\n');
  } else {
    const byKind = new Map();
    for (const row of contradictions) {
      const key = `${row.kind}|${row.need}`;
      if (!byKind.has(key)) byKind.set(key, []);
      byKind.get(key).push(row);
    }

    const hard = contradictions.filter((row) => !COARSE.has(row.kind)).length;
    console.log(
      `CONTRADICTIONS — ${hard} entries where the two statements disagree` +
        (contradictions.length > hard
          ? `, plus ${contradictions.length - hard} coarse-satisfaction entries to read`
          : '') +
        '\n'
    );
    const rank = ([key, list]) => [COARSE.has(key.split('|')[0]) ? 1 : 0, -list.length];
    for (const [key, list] of [...byKind].sort((a, b) => {
      const [ac, an] = rank(a);
      const [bc, bn] = rank(b);
      return ac - bc || an - bn;
    })) {
      const [kind, need] = key.split('|');
      // THE MOST RECENT ONE IS THE HEADLINE. A derivation fixed last week leaves
      // its wrong rows behind for ever — `product_property` was corrected on
      // 2026-08-31 and every run before it still reads as broken — so a group
      // whose latest occurrence predates the fix is history, and one that
      // reaches today is a live fault.
      const latest = list.map((r) => r.at).filter(Boolean).sort().at(-1);
      console.log(`  ${list.length} × ${need} — ${KINDS[kind]}`);
      console.log(`      ${needLabel(need) ?? ''}`);
      console.log(`      most recent: ${latest ? String(latest).slice(0, 10) : 'unknown'}`);
      for (const row of list.slice(0, examples)) {
        console.log(`      · [${row.subject}] state=${row.state} finding=${row.finding} — ${row.title}`);
      }
      if (list.length > examples) {
        console.log(`      … and ${list.length - examples} more`);
      }
      console.log('');
    }
  }

  // --- the full picture, so a reader can see what is normal -------------------
  console.log('STATE × FINDING, PER NEED\n');
  for (const [need, states] of [...seen].sort()) {
    const total = [...states.values()].reduce(
      (sum, findings) => sum + [...findings.values()].reduce((a, b) => a + b, 0),
      0
    );
    console.log(`  ${need}  (${total})`);
    for (const [state, findings] of [...states].sort()) {
      const cells = [...findings]
        .sort((a, b) => b[1] - a[1])
        .map(([finding, count]) => `${finding}=${count}`)
        .join('  ');
      console.log(`     ${state.padEnd(14)} ${cells}`);
    }

    // A finding this need can take and never has. Not a fault on its own — the
    // corpus may simply not contain it — but a branch no rule can be tested
    // against, which is worth knowing before writing one.
    const declared = findingValues(need);
    if (!declared) {
      // `(null)` here is a third statement and not a gap: no rule branches on
      // this need's value, so nothing derives one. Said out loud, because a
      // column of nulls otherwise reads as a broken derivation.
      console.log('     no findings vocabulary — nothing branches on its value');
    } else {
      const observed = new Set([...states.values()].flatMap((f) => [...f.keys()]));
      const never = declared.filter((value) => !observed.has(value));
      if (never.length > 0) {
        console.log(`     never seen: ${never.join(', ')}`);
      }
      // Every entry null on a need that HAS a vocabulary means these rows were
      // written before the derivation existed. Historical, not a live fault.
      if (observed.size === 1 && observed.has('(null)')) {
        console.log("     every entry null — these rows predate this need's derivation");
      }
    }
    console.log('');
  }

  console.log('Read the contradictions before enforcing anything on these findings.\n');
}

const COARSE = new Set(['satisfied_but_coarse']);

const KINDS = {
  satisfied_but_coarse:
    'a tool settled the need without being able to name a value — legitimate, but check the source is not ALWAYS this coarse',
  satisfied_but_empty:
    'a tool satisfied the need and the finding says nothing was found — the `product_property` shape',
  unsatisfied_but_found:
    'nothing satisfied the need and the finding claims a value — derived from a tool the need does not count',
  unavailable_but_found:
    'no tool in this ticket\'s registry could settle it, and the finding has a value anyway'
};

/**
 * Which of the two statements about a need contradicts the other, if either.
 *
 * `null` findings are not a contradiction in any state: a need nothing branches
 * on is deliberately left unscored, which is a third statement — "no answer
 * depends on this" — and not a claim about the evidence at all.
 */
function contradictionKind(state, finding, need) {
  if (finding == null) return null;
  if (POSITIVE_ABSENCE.has(`${need}:${finding}`)) return null;

  if (state === 'satisfied') {
    // `unknown` BESIDE `satisfied` IS NOT A DISAGREEMENT, and reporting it as
    // one contradicts a decision this codebase already took: `unknown` is the
    // honest answer when a tool settles a need without being able to name the
    // value — listing the active promotions establishes a known code exists
    // without saying which state that one code is in. Reported below as its own
    // class, because it is worth READING (a source that is always coarse may not
    // deserve to satisfy at all — that is how the 2026-09-01 listing bug was
    // found) and it is not worth FAILING on.
    if (finding === 'unknown') return 'satisfied_but_coarse';
    return EMPTY_FINDINGS.has(finding) ? 'satisfied_but_empty' : null;
  }
  // Anything that is not an "empty" finding is a positive claim, and only a
  // satisfied need is entitled to one. `unknown` in an unsatisfied state is the
  // honest, expected pairing and is not reported.
  if (EMPTY_FINDINGS.has(finding)) return null;
  // ...unless the claim IS the reason the need stayed open, and only where the
  // tool actually ran to produce it.
  if (isDesignedGap(need, finding, state)) return null;
  return state === 'unavailable' ? 'unavailable_but_found' : 'unsatisfied_but_found';
}

function valueOf(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1];
}

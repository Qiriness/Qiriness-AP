import { pathToFileURL } from 'node:url';

import { loadConfig, loadEnv } from './lib/sync-config.mjs';
import { createSupabaseClient, supabaseSelectAll } from './lib/supabase-rest-client.mjs';

// Is the prompt cache doing anything, and where.
//
//   npm run report:prompt-cache
//   npm run report:prompt-cache -- --since 2026-09-05
//
// WHY THIS IS THE FIRST COST QUESTION. Input is 76% of the bill at 12.5 input
// tokens per output token, so the prompt cache is the largest single lever on
// what this agent costs — and `prompt_tokens` ALREADY INCLUDES cached tokens, so
// every other usage number is silent about it. A cache working perfectly and one
// that never engages look identical in `input_tokens`.
//
// PER PASS AND PER TURN, because those are two different questions with two
// different fixes:
//
//   nothing cached anywhere        the prefix is too short, or not stable
//   cached on turn 2+, not turn 1  the expected shape: a run reuses its own
//                                  prompt, but two tickets share too little
//   cached on turn 1 too           tickets are sharing a prefix, which needs
//                                  more than the system prompt to be true
//
// WHAT IT DELIBERATELY CANNOT TELL YOU: the discount RATE. This counts tokens
// served from cache, not what they cost. The rate decides whether lengthening a
// prompt to reach the cacheable minimum helps or hurts, and it comes from the
// pricing page rather than from here — see codex_plans/Model_Cost_Notes.md.
//
// ZERO COST. One read, no writes, no model call.

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

async function main() {
  const supabase = createSupabaseClient(loadConfig(loadEnv()));
  const since = valueOf('--since');

  const rows = (
    await supabaseSelectAll(
      supabase,
      'llm_usage',
      {},
      'ticket_id,pass,model,input_tokens,cached_input_tokens,output_tokens,occurred_at,succeeded'
    )
  ).filter((r) => r.succeeded !== false && (!since || String(r.occurred_at ?? '') >= since));

  if (rows.length === 0) {
    console.log('\nNo usage rows in range.\n');
    return;
  }

  const anyCached = rows.some((r) => Number(r.cached_input_tokens || 0) > 0);
  const total = rows.reduce((s, r) => s + Number(r.input_tokens || 0), 0);
  const cached = rows.reduce((s, r) => s + Number(r.cached_input_tokens || 0), 0);

  console.log(`\nPROMPT CACHE — ${rows.length} calls${since ? ` since ${since}` : ''}\n`);
  console.log(`  input tokens          ${total.toLocaleString()}`);
  console.log(`  served from cache     ${cached.toLocaleString()}  (${pct(cached, total)})\n`);

  if (!anyCached) {
    // A COLUMN OF ZEROES IS AMBIGUOUS and saying so is the point: it reads the
    // same whether the cache never engages or the field was added after these
    // rows were written.
    console.log('  Nothing cached in this range. Either no prompt reached the cacheable');
    console.log('  minimum with a stable prefix, or these rows predate the column.');
    console.log('  Re-run one ticket and look again before drawing a conclusion.\n');
  }

  // --- per pass --------------------------------------------------------------
  const byPass = new Map();
  for (const r of rows) {
    if (!byPass.has(r.pass)) byPass.set(r.pass, { calls: 0, input: 0, cached: 0, hits: 0 });
    const acc = byPass.get(r.pass);
    acc.calls += 1;
    acc.input += Number(r.input_tokens || 0);
    acc.cached += Number(r.cached_input_tokens || 0);
    if (Number(r.cached_input_tokens || 0) > 0) acc.hits += 1;
  }
  console.log(`  ${'pass'.padEnd(12)} ${'calls'.padStart(6)} ${'input'.padStart(10)} ${'cached'.padStart(10)} ${'share'.padStart(7)} ${'calls hit'.padStart(10)}`);
  for (const [pass, v] of [...byPass].sort((a, b) => b[1].input - a[1].input)) {
    console.log(
      `  ${pass.padEnd(12)} ${String(v.calls).padStart(6)} ${v.input.toLocaleString().padStart(10)} ` +
        `${v.cached.toLocaleString().padStart(10)} ${pct(v.cached, v.input).padStart(7)} ${`${v.hits}/${v.calls}`.padStart(10)}`
    );
  }

  // --- per turn, inside one investigation ------------------------------------
  //
  // THE DIAGNOSTIC. Turn 1 can only share the system prompt with other tickets;
  // turn 2 onward shares the whole of turn 1 with itself. If caching works at
  // all, it shows up here as a step change between the two.
  const inv = rows.filter((r) => r.pass === 'investigate');
  const byRun = new Map();
  for (const r of inv) {
    const key = `${r.ticket_id}|${String(r.occurred_at).slice(0, 13)}`;
    if (!byRun.has(key)) byRun.set(key, []);
    byRun.get(key).push(r);
  }
  const turns = [];
  for (const list of byRun.values()) {
    list.sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
    list.forEach((r, i) => {
      turns[i] ??= { calls: 0, input: 0, cached: 0 };
      turns[i].calls += 1;
      turns[i].input += Number(r.input_tokens || 0);
      turns[i].cached += Number(r.cached_input_tokens || 0);
    });
  }
  if (turns.length > 0) {
    console.log(`\n  investigation, by turn within a run`);
    console.log(`  ${'turn'.padEnd(6)} ${'calls'.padStart(6)} ${'avg input'.padStart(10)} ${'avg cached'.padStart(11)} ${'share'.padStart(7)}`);
    turns.forEach((t, i) => {
      console.log(
        `  ${String(i + 1).padEnd(6)} ${String(t.calls).padStart(6)} ${String(Math.round(t.input / t.calls)).padStart(10)} ` +
          `${String(Math.round(t.cached / t.calls)).padStart(11)} ${pct(t.cached, t.input).padStart(7)}`
      );
    });
    const first = turns[0];
    const later = turns.slice(1).reduce((s, t) => ({ input: s.input + t.input, cached: s.cached + t.cached }), { input: 0, cached: 0 });
    console.log('');
    if (first.cached === 0 && later.cached > 0) {
      console.log('  Turn 1 caches nothing and later turns do — a run reuses its own prompt,');
      console.log('  but two tickets share too little for the cache to engage. Expected.');
    } else if (first.cached > 0) {
      console.log('  Turn 1 is caching, so tickets are sharing a prefix with each other.');
    } else if (later.cached === 0) {
      console.log('  No turn caches. Check prompt length against the cacheable minimum, and');
      console.log('  whether anything ticket-specific appears early in the prompt.');
    }
  }
  console.log('');
}

const pct = (part, whole) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—');

function valueOf(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function isDirectRun() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

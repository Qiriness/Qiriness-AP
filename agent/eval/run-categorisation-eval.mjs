// Runs the categoriser against the labelled review set and reports agreement.
//
// Deliberately drives the REAL createCategoriser + openai-client, so what is
// measured is exactly what production does — prompt, schema, normalisation and
// all. Read-only: nothing is written to Supabase and no mailbox is touched.
//
//   npm run eval:categorise                 # whole set
//   npm run eval:categorise -- --only=cosmeto      # id substring filter
//   npm run eval:categorise -- --model=gpt-4o      # compare tiers
//   npm run eval:categorise -- --repeat=3          # stability across runs
//   npm run eval:categorise -- --verbose           # print every case, not just failures

import { loadAgentConfig } from '../src/config.mjs';
import { createOpenAIClient } from '../src/llm/openai-client.mjs';
import { createCategoriser } from '../src/pipeline/categorise.mjs';
import { CASES } from './categorisation-cases.mjs';
import { scoreCase, summarise, confusions, pct } from './score-categorisation.mjs';

const CONCURRENCY = 4;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadAgentConfig();
  if (!config.openaiApiKey) {
    throw new Error('OPENAI_API_KEY is not set — the eval needs a real model.');
  }

  const model = args.model || config.categoriserModel;
  const cases = args.only ? CASES.filter((c) => c.id.includes(args.only)) : CASES;
  if (cases.length === 0) {
    throw new Error(`No case id matches "${args.only}".`);
  }

  const openai = createOpenAIClient({ apiKey: config.openaiApiKey });
  const { categorise } = createCategoriser(openai, { model });

  console.log(`\nCategorisation review set — ${cases.length} cases · model ${model}` +
    (args.repeat > 1 ? ` · ${args.repeat} runs` : ''));

  const runs = [];
  for (let run = 1; run <= args.repeat; run += 1) {
    const started = Date.now();
    const scores = await runOnce(cases, categorise, args);
    runs.push(scores);
    report(cases, scores, args, Date.now() - started, args.repeat > 1 ? run : null);
  }

  if (args.repeat > 1) {
    reportStability(cases, runs);
  }

  const failures = runs[runs.length - 1].filter((s) => !s.exact).length;
  if (args.strict && failures > 0) {
    process.exitCode = 1;
  }
}

async function runOnce(cases, categorise, args) {
  const scores = new Array(cases.length);
  let next = 0;

  async function worker() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= cases.length) return;
      const testCase = cases[index];
      try {
        const result = await categorise({
          subject: testCase.subject,
          messages: [{ subject: testCase.subject, body_text: testCase.body }]
        });
        scores[index] = scoreCase(testCase, result);
      } catch (error) {
        // An API failure is not a categorisation failure; keep it visibly distinct.
        scores[index] = {
          id: testCase.id,
          error: error.message,
          subject: false,
          kind: false,
          level: false,
          levelFromPair: null,
          secondary: { status: 'ok', got: null },
          exact: false,
          actual: {}
        };
      }
      if (args.verbose) process.stdout.write('.');
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, cases.length) }, worker));
  if (args.verbose) process.stdout.write('\n');
  return scores;
}

function report(cases, scores, args, elapsedMs, runNumber) {
  const byId = new Map(cases.map((c) => [c.id, c]));
  console.log(runNumber ? `\n--- run ${runNumber} ---` : '');

  for (const score of scores) {
    const testCase = byId.get(score.id);
    const failed = !score.exact || score.secondary.status !== 'ok';
    if (!failed && !args.verbose) continue;

    const mark = score.error ? '!' : score.exact ? '~' : 'X';
    console.log(`\n${mark} ${score.id}`);
    if (score.error) {
      console.log(`    api error: ${score.error}`);
      continue;
    }
    console.log(`    want ${label(testCase.expect)}${secondaryLabel(testCase.expectSecondary)}`);
    console.log(`    got  ${label(score.actual)}${secondaryLabel({
      category: score.actual.secondary_category,
      request_kind: score.actual.secondary_request_kind
    })}`);
    console.log(`    why  ${score.actual.reason || '(none)'}`);
    if (!score.exact) console.log(`    note ${testCase.note}`);
  }

  const s = summarise(scores);
  console.log(`\n${'-'.repeat(64)}`);
  console.log(`subject  ${s.subject}/${s.total} (${pct(s.subject, s.total)})`);
  console.log(`kind     ${s.kind}/${s.total} (${pct(s.kind, s.total)})`);
  console.log(`level    ${s.level}/${s.total} (${pct(s.level, s.total)})` +
    `   on a correct pair: ${s.levelOnCorrectPair.correct}/${s.levelOnCorrectPair.of}`);
  console.log(`all three ${s.exact}/${s.total} (${pct(s.exact, s.total)})`);
  console.log(`secondary  found ${s.secondary.ok} · missed ${s.secondary.missed} · ` +
    `wrong ${s.secondary.wrong} · spurious ${s.secondary.spurious}`);

  const confused = confusions(cases, scores);
  if (confused.length > 0) {
    console.log(`\nsubject confusions: ${confused.map(([k, n]) => `${k} (${n})`).join(', ')}`);
  }
  console.log(`\n${(elapsedMs / 1000).toFixed(1)}s`);
}

/** Same input, same temperature 0 — anything that moves between runs is unstable. */
function reportStability(cases, runs) {
  const unstable = [];
  for (let i = 0; i < cases.length; i += 1) {
    const signatures = new Set(runs.map((run) => label(run[i].actual)));
    if (signatures.size > 1) {
      unstable.push(`${cases[i].id}: ${[...signatures].join(' | ')}`);
    }
  }
  console.log(`\n${'-'.repeat(64)}`);
  console.log(unstable.length === 0
    ? `stable across ${runs.length} runs`
    : `UNSTABLE across runs (${unstable.length}):\n  ${unstable.join('\n  ')}`);
}

function label(value = {}) {
  return `${value.category || '?'}/${value.request_kind || '?'} L${value.level ?? '?'}`;
}

function secondaryLabel(secondary) {
  if (!secondary?.category) return '';
  return `  + ${secondary.category}/${secondary.request_kind || '?'}`;
}

function parseArgs(argv) {
  const get = (name) => {
    const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  return {
    only: get('only'),
    model: get('model'),
    repeat: Math.max(1, Number.parseInt(get('repeat') || '1', 10)),
    verbose: argv.includes('--verbose'),
    strict: argv.includes('--strict')
  };
}

main().catch((error) => {
  console.error(`eval failed: ${error.message}`);
  process.exitCode = 1;
});

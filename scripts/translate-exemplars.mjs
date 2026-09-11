import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { createOpenAIClient } from '../agent/src/llm/openai-client.mjs';
import { loadEnv } from './lib/sync-config.mjs';
import { parseExemplarDocument, validateExemplar } from './lib/exemplar-import.mjs';
import {
  TRANSLATION_LANGUAGES,
  TRANSLATION_SCHEMA,
  buildTranslationPrompt,
  planTranslations,
  validateTranslation
} from './lib/exemplar-translation.mjs';

// Generates the non-French phrasings of Email-Example-Queries.md, into
// Email-Example-Queries.translations.json.
//
// WHY A CHECKED-IN FILE RATHER THAN A WRITE STRAIGHT TO THE TABLE. The library
// is 38 exemplars and all 38 are APPROVED, and approval is the only gate on
// embedding — so a translation written directly to `support_exemplar_phrasings`
// would be vectorised by the next `embed:exemplars` run and matched against real
// customer mail without anybody having read it. DECISIONS.md says "a human sees
// the output at approval time because the approval gate already exists"; that is
// true of a NEW exemplar and false of a new phrasing on an approved one. The
// file is the missing gate: the model writes it, a person reads the diff, and
// `import:exemplars` is what puts it in the table.
//
// IT IS ALSO WHAT MAKES THIS RERUNNABLE. Each entry records the hash of the
// source text it was made from, so editing one French variant re-translates that
// variant and nothing else. A cold run is ~560 calls; a run after an edit is 4.
//
// TWO PASSES, IN THIS ORDER, and the order is not arbitrary:
//   npm run translate:exemplars -- --languages=fr    the 11 foreign phrasings
//   npm run translate:exemplars                      everything, all five
// The first is cheap and reviewable on its own — French is the language the team
// reads — and getting it wrong is the failure that would poison the second.
//
// Flags: --dry-run (plan and cost, call nothing), --languages=fr,en (default all
// five), --exemplar=D-33 (one entry), --limit=N (cap the calls this run).

const DEFAULT_SOURCE = new URL('../Email-Example-Queries.md', import.meta.url);
const DEFAULT_OUTPUT = new URL('../Email-Example-Queries.translations.json', import.meta.url);

/**
 * `gpt-4o`, not the mini tier, and this is the one place in the pipeline where
 * that is worth arguing.
 *
 * The register rule IS the task — a translation that tidies « jai pas recu ma
 * commande » into "I have not received my order" rebuilds the exact mismatch the
 * phrasings exist to remove — and instruction-following on a constraint that
 * cuts against the model's grain is what the tiers actually differ on. The whole
 * corpus is ~560 short lines, so the difference between the tiers here is cents,
 * paid once, on rows that are then read by a person.
 */
const MODEL = 'gpt-4o';

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

async function main() {
  const args = parseTranslateArgs(process.argv.slice(2));

  const markdown = readFileSync(DEFAULT_SOURCE, 'utf8');
  const warnings = [];
  const parsed = parseExemplarDocument(markdown, { warn: (m) => warnings.push(m) });

  // Only entries the importer would actually write. Translating a phrasing of an
  // exemplar that will be skipped at import is spend on a row that cannot exist.
  const usable = parsed.filter((exemplar) => validateExemplar(exemplar).length === 0);
  const selected = args.exemplar
    ? usable.filter((e) => e.exemplarKey === args.exemplar)
    : usable;

  if (selected.length === 0) {
    throw new Error(
      args.exemplar
        ? `No usable exemplar named ${args.exemplar}.`
        : 'The document parsed to no usable exemplars.'
    );
  }

  const held = readHeld(DEFAULT_OUTPUT);
  const work = [];

  for (const exemplar of selected) {
    const { plans, fresh } = planTranslations(exemplar.phrasings, {
      languages: args.languages,
      existing: held[exemplar.exemplarKey] ?? {}
    });
    work.push({ exemplar, plans, fresh });
  }

  const pending = work.flatMap((w) => w.plans);
  const kept = work.reduce((n, w) => n + w.fresh.length, 0);

  reportPlan({ selected, pending, kept, warnings, args });

  if (args.dryRun) {
    console.log('\nDry run: no model calls, nothing written.');
    return;
  }
  if (pending.length === 0) {
    console.log('\nNothing to translate. The file is already current.');
    return;
  }

  const env = loadEnv();
  const client = createOpenAIClient({ apiKey: env.OPENAI_API_KEY });

  const results = await translateAll({ client, work, limit: args.limit });

  // MERGED INTO WHAT IS ALREADY THERE, never replacing it. `--languages=fr` and
  // `--exemplar=` both narrow the run, and a narrowed run that rewrote the file
  // from its own results would delete every translation it was not asked about.
  const merged = mergeHeld(held, results.entries);
  writeFileSync(DEFAULT_OUTPUT, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');

  reportRun({ results, kept, output: DEFAULT_OUTPUT });
}

/**
 * One call per phrasing per language, sequentially.
 *
 * NOT BATCHED INTO ONE CALL PER PHRASING, though four languages at once would be
 * a quarter of the calls. A batch shares one output budget across four answers,
 * and the failure mode is the long CV-02 phrasing coming back with three good
 * translations and a truncated fourth — which `validateTranslation` cannot see,
 * because a truncated sentence is a well-formed string. One call, one line, one
 * thing that can go wrong.
 *
 * FAILURES ARE COLLECTED, NOT THROWN. A run of 560 calls will meet a refusal or
 * a network fault eventually, and losing the other 559 to it would mean paying
 * for them twice. Anything that fails is simply absent from the file, so the
 * next run plans it again.
 */
async function translateAll({ client, work, limit }) {
  const entries = {};
  const failures = [];
  let called = 0;
  let done = 0;

  const total = limit
    ? Math.min(limit, work.reduce((n, w) => n + w.plans.length, 0))
    : work.reduce((n, w) => n + w.plans.length, 0);

  for (const { exemplar, plans } of work) {
    for (const plan of plans) {
      if (limit && called >= limit) {
        return { entries, failures, called, done, stoppedAtLimit: true, total };
      }
      called += 1;

      let text;
      try {
        const { system, user } = buildTranslationPrompt(plan);
        const result = await client.completeJson({
          model: MODEL,
          system,
          user,
          schema: TRANSLATION_SCHEMA,
          schemaName: 'translation',
          maxTokens: 500,
          pass: 'other'
        });
        text = result?.translation;
      } catch (error) {
        failures.push({ key: `${exemplar.exemplarKey} ${plan.key}`, reason: error.message });
        continue;
      }

      const problems = validateTranslation({
        text,
        sourceText: plan.sourceText,
        language: plan.language
      });
      if (problems.length > 0) {
        failures.push({ key: `${exemplar.exemplarKey} ${plan.key}`, reason: problems.join(', ') });
        continue;
      }

      entries[exemplar.exemplarKey] ??= {};
      entries[exemplar.exemplarKey][plan.key] = {
        index: plan.index,
        sourceIndex: plan.sourceIndex,
        sourceLanguage: plan.sourceLanguage,
        sourceText: plan.sourceText,
        sourceHash: plan.sourceHash,
        language: plan.language,
        text: String(text).trim()
      };
      done += 1;

      if (done % 25 === 0) console.log(`  ${done}/${total} translated…`);
    }
  }

  return { entries, failures, called, done, stoppedAtLimit: false, total };
}

/**
 * The file as it stands, keyed exemplar → `index:language`.
 *
 * A MISSING FILE IS THE COLD START and not an error — the first run has nothing
 * to keep. A malformed one IS an error: silently treating it as empty would
 * re-translate the whole corpus and overwrite whatever was actually in there.
 */
function readHeld(output) {
  if (!existsSync(output)) return {};

  const raw = readFileSync(output, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${output.pathname} is not readable JSON (${error.message}). Fix or delete it.`);
  }
  return parsed?.exemplars ?? {};
}

function mergeHeld(held, produced) {
  const merged = { ...held };
  for (const [key, entries] of Object.entries(produced)) {
    merged[key] = { ...(merged[key] ?? {}), ...entries };
  }

  // Sorted on the way out, so a re-run's diff shows what changed rather than
  // what moved. The file is reviewed as a diff — that is its whole job.
  const exemplars = {};
  for (const key of Object.keys(merged).sort()) {
    const inner = merged[key];
    exemplars[key] = Object.fromEntries(
      Object.keys(inner)
        .sort((a, b) => inner[a].index - inner[b].index)
        .map((k) => [k, inner[k]])
    );
  }

  return {
    note:
      'Generated by scripts/translate-exemplars.mjs from Email-Example-Queries.md. ' +
      'Reviewed as a diff, then written to support_exemplar_phrasings by import:exemplars. ' +
      'Do not edit sourceText or sourceHash by hand: they are the staleness gate.',
    model: MODEL,
    languages: TRANSLATION_LANGUAGES,
    exemplars
  };
}

function reportPlan({ selected, pending, kept, warnings, args }) {
  console.log(`Source: ${selected.length} usable exemplar(s), languages ${args.languages.join(', ')}.`);
  console.log(`To translate: ${pending.length}. Already current: ${kept}.`);

  if (args.limit) console.log(`Capped at ${args.limit} call(s) this run.`);

  const byLanguage = pending.reduce((acc, p) => {
    acc[p.language] = (acc[p.language] || 0) + 1;
    return acc;
  }, {});
  if (pending.length > 0) {
    console.log(
      `  ${Object.entries(byLanguage)
        .sort((a, b) => b[1] - a[1])
        .map(([lang, n]) => `${n} ${lang}`)
        .join(', ')}`
    );
  }

  const parseWarnings = warnings.filter((w) => /language marker/.test(w));
  for (const warning of parseWarnings) console.log(`! ${warning}`);
}

function reportRun({ results, kept, output }) {
  console.log(`\nTranslated ${results.done} of ${results.called} call(s); kept ${kept} unchanged.`);

  if (results.stoppedAtLimit) {
    console.log('Stopped at --limit. Re-run to continue where this left off.');
  }
  if (results.failures.length > 0) {
    console.log(`\n${results.failures.length} did not produce a usable translation:`);
    for (const failure of results.failures.slice(0, 20)) {
      console.log(`  ${failure.key} — ${failure.reason}`);
    }
    if (results.failures.length > 20) {
      console.log(`  … and ${results.failures.length - 20} more`);
    }
    console.log('They are absent from the file, so the next run plans them again.');
  }

  console.log(`\nWritten to ${output.pathname}.`);
  console.log('Read the diff, then `npm run import:exemplars` and `npm run embed:exemplars`.');
}

export function parseTranslateArgs(argv) {
  const args = {
    dryRun: false,
    languages: [...TRANSLATION_LANGUAGES],
    exemplar: null,
    limit: null
  };

  for (const arg of argv) {
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg.startsWith('--languages=')) {
      args.languages = arg
        .slice('--languages='.length)
        .split(',')
        .map((code) => code.trim().toLowerCase())
        .filter(Boolean);
    } else if (arg.startsWith('--exemplar=')) {
      args.exemplar = arg.slice('--exemplar='.length).trim();
    } else if (arg.startsWith('--limit=')) {
      args.limit = Number.parseInt(arg.slice('--limit='.length), 10);
    }
  }

  if (args.languages.length === 0) {
    throw new Error('--languages needs at least one code.');
  }
  for (const code of args.languages) {
    if (!TRANSLATION_LANGUAGES.includes(code)) {
      throw new Error(
        `--languages: ${code} is not a translation language (${TRANSLATION_LANGUAGES.join(', ')}).`
      );
    }
  }
  if (args.limit !== null && (!Number.isInteger(args.limit) || args.limit < 1)) {
    throw new Error('--limit must be a positive integer.');
  }

  return args;
}

function isDirectRun() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

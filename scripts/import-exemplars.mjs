import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { parseArgs, loadConfig, loadEnv } from './lib/sync-config.mjs';
import {
  createSupabaseClient,
  supabaseDeleteWhereIn,
  supabaseSelect,
  supabaseUpsert
} from './lib/supabase-rest-client.mjs';
import { hashEmbeddingInput } from './lib/embeddings/embedding-input.mjs';
import {
  TRANSLATION_INDEX_BASE,
  parseExemplarDocument,
  validateExemplar
} from './lib/exemplar-import.mjs';
import { sourceHash } from './lib/exemplar-translation.mjs';
import { resolveShopId } from '../agent/src/lib/shop.mjs';

// Loads Email-Example-Queries.md into support_exemplars + phrasings.
//
// IDEMPOTENT, AND IT HAS TO BE: this document is edited by hand and re-imported,
// so a second run over unchanged text must not duplicate rows, must not orphan
// phrasings, and — the one that matters — must not invalidate embeddings that
// are still correct. Phrasings are upserted on (exemplar, index) with their
// content hash, so unchanged text keeps its vector and the embed reconciler
// stays a no-op.
//
// IT NEVER APPROVES ANYTHING. Every exemplar is written as a draft, and approval
// is what gates the vector — so nothing imported here is reachable by retrieval
// until a person has read it. That review is not a formality: the phrasings are
// real customer sentences and several quote order numbers.
//
// TRANSLATIONS COME FROM A SECOND FILE, and are attached here rather than
// generated here. `translate-exemplars.mjs` writes them; this reads them, drops
// any whose source text has since been edited, and upserts them alongside the
// authored rows at `phrasing_index >= 100`. That file is the review gate: all 38
// exemplars are approved, approval is the only thing gating a vector, so a
// translation written straight to the table would be embedded and matched
// against real mail without anyone reading it.
//
// A STALE TRANSLATION IS DROPPED, NOT WRITTEN. Each entry carries the hash of
// the phrasing it was made from. Editing a French variant without re-running the
// translator would otherwise leave four rows in the index answering a question
// nobody asks any more, and they would look exactly like the fresh ones.
//
// Flags: --dry-run (parse and report, write nothing), --file=PATH.

const DEFAULT_FILE = new URL('../Email-Example-Queries.md', import.meta.url);
const TRANSLATIONS_FILE = new URL('../Email-Example-Queries.translations.json', import.meta.url);

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = args.file ? new URL(pathToFileURL(args.file)) : DEFAULT_FILE;
  const markdown = readFileSync(file, 'utf8');

  const warnings = [];
  const parsed = parseExemplarDocument(markdown, { warn: (m) => warnings.push(m) });

  const usable = [];
  const skipped = [];
  for (const exemplar of parsed) {
    const problems = validateExemplar(exemplar);
    (problems.length === 0 ? usable : skipped).push({ exemplar, problems });
  }

  const held = readTranslations();
  const translations = {
    hasFile: held.hasFile,
    ...attachTranslations(usable.map((u) => u.exemplar), held.exemplars, (m) => warnings.push(m))
  };

  report({ parsed, usable, skipped, warnings, translations });

  if (args.dryRun) {
    console.log('\nDry run: nothing written.');
    return;
  }

  const config = loadConfig(loadEnv());
  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);

  const written = await write({
    supabase,
    shopId,
    usable: usable.map((u) => u.exemplar),
    pruneTranslations: translations.hasFile
  });
  console.log(
    `\nImported ${written.exemplars} exemplar(s) and ${written.phrasings} phrasing(s) ` +
      `(${written.translated} translated); removed ${written.removed} stale phrasing(s).`
  );

  // READ BACK RATHER THAN ASSUMED. This line used to say "All are drafts" every
  // time, which stopped being true the moment anything was approved — and it is
  // the line a reader trusts to know whether a re-import silently un-approved
  // the corpus. It does not: the upsert never writes approval_status. Saying so
  // from the table is the only version of this sentence that stays true.
  //
  // AND IT IS A REPORT, SO IT MUST NOT BE ABLE TO FAIL THE IMPORT. The rows are
  // already written by this point; a transient read here would otherwise turn a
  // successful import into a non-zero exit and invite someone to re-run it.
  // Caught the first time this ran, on exactly that failure.
  try {
    const states = await supabaseSelect(
      supabase,
      'support_exemplars',
      { shop_id: shopId },
      'approval_status'
    );
    const byState = states.reduce((acc, row) => {
      acc[row.approval_status] = (acc[row.approval_status] || 0) + 1;
      return acc;
    }, {});
    const summary = Object.entries(byState)
      .sort((a, b) => b[1] - a[1])
      .map(([state, n]) => `${n} ${state}`)
      .join(', ');

    console.log(`Approval state, unchanged by this import: ${summary}.`);
    console.log(
      byState.approved
        ? 'Run `npm run embed:exemplars` to vectorise anything new or edited.'
        : 'Nothing is approved, so nothing is retrievable yet — approve, then `npm run embed:exemplars`.'
    );
  } catch (error) {
    console.log(`(could not read approval state back: ${error.message})`);
    console.log('The import itself succeeded. Run `npm run embed:exemplars` when ready.');
  }
}

/**
 * The generated translations, or nothing.
 *
 * ABSENT IS FINE AND IS NOT A DEFAULT TO PAPER OVER: the document imports
 * perfectly well without a single translation, and it did for the first month.
 * Malformed is not fine — reading a broken file as empty would silently import a
 * French-only library and report success.
 */
function readTranslations() {
  if (!existsSync(TRANSLATIONS_FILE)) return { hasFile: false, exemplars: {} };

  const raw = readFileSync(TRANSLATIONS_FILE, 'utf8');
  try {
    return { hasFile: true, exemplars: JSON.parse(raw)?.exemplars ?? {} };
  } catch (error) {
    throw new Error(
      `Email-Example-Queries.translations.json is not readable JSON (${error.message}). ` +
        'Fix it or delete it and re-run `npm run translate:exemplars`.'
    );
  }
}

/**
 * Adds the translated phrasings to each exemplar's list, in place.
 *
 * TWO THINGS DISQUALIFY A TRANSLATION, and either would otherwise leave a row in
 * the retrieval index answering a question nobody asks any more: its source
 * phrasing no longer exists, or its source text has changed since the
 * translation was made. Both are reported rather than thrown — the authored half
 * of the import is still correct, and the fix is to re-run the translator rather
 * than to block the load.
 */
export function attachTranslations(exemplars, held, warn = () => {}) {
  let attached = 0;
  let dropped = 0;

  for (const exemplar of exemplars) {
    const entries = held[exemplar.exemplarKey];
    if (!entries) continue;

    const authored = new Map(exemplar.phrasings.map((p) => [p.index, p]));

    for (const entry of Object.values(entries)) {
      const source = authored.get(entry.sourceIndex);
      if (!source) {
        warn(
          `${exemplar.exemplarKey}: dropped a ${entry.language} translation of ` +
            `phrasing ${entry.sourceIndex}, which no longer exists`
        );
        dropped += 1;
        continue;
      }
      if (sourceHash(source.text) !== entry.sourceHash) {
        warn(
          `${exemplar.exemplarKey}: dropped the ${entry.language} translation of phrasing ` +
            `${entry.sourceIndex} — its source text has changed since it was made`
        );
        dropped += 1;
        continue;
      }

      exemplar.phrasings.push({
        index: entry.index,
        kind: 'translated',
        text: entry.text,
        language: entry.language,
        translatedFromIndex: entry.sourceIndex
      });
      attached += 1;
    }
  }

  return { attached, dropped };
}

async function write({ supabase, shopId, usable, pruneTranslations }) {
  // One upsert for the parents, so a re-import updates in place rather than
  // creating a second row per key.
  const rows = usable.map((e) => ({
    shop_id: shopId,
    exemplar_key: e.exemplarKey,
    canonical_question: e.canonicalQuestion,
    category: e.category,
    request_kind: e.requestKind,
    requirement_needs: e.requirementNeeds,
    demand_message_count: e.demandMessageCount,
    source_note: e.sourceNote
    // approval_status is deliberately absent: the column default is `draft`, and
    // naming it here would let a careless edit turn this into a bulk approval.
  }));

  await supabaseUpsert(supabase, 'support_exemplars', rows, 'shop_id,exemplar_key');

  // Read the ids back rather than assuming the upsert returned them in order.
  const stored = await supabaseSelect(
    supabase,
    'support_exemplars',
    { shop_id: shopId },
    'id,exemplar_key'
  );
  const idByKey = new Map(stored.map((row) => [row.exemplar_key, row.id]));

  const phrasingRows = [];
  for (const exemplar of usable) {
    const exemplarId = idByKey.get(exemplar.exemplarKey);
    if (!exemplarId) continue;
    for (const phrasing of exemplar.phrasings) {
      phrasingRows.push({
        support_exemplar_id: exemplarId,
        phrasing_index: phrasing.index,
        phrasing_kind: phrasing.kind,
        phrasing_text: phrasing.text,
        language: phrasing.language,
        // Null on everything but a translation, and the check constraint reads
        // it both ways: a translation must name a source, and nothing else may.
        translated_from_index: phrasing.translatedFromIndex ?? null,
        // Covers the text only. The embedding's own staleness gate is
        // `embedded_input_hash`, which is computed from the composed input —
        // these are deliberately different hashes, as on the knowledge side.
        content_hash: hashEmbeddingInput(phrasing.text)
      });
    }
  }

  await supabaseUpsert(
    supabase,
    'support_exemplar_phrasings',
    phrasingRows,
    'support_exemplar_id,phrasing_index'
  );

  const removed = await removeStalePhrasings({ supabase, usable, idByKey, pruneTranslations });

  return {
    exemplars: rows.length,
    phrasings: phrasingRows.length,
    translated: phrasingRows.filter((row) => row.phrasing_kind === 'translated').length,
    removed
  };
}

/**
 * Drops phrasings this import did not write.
 *
 * The upsert overwrites the indexes it was given but cannot know that an
 * exemplar which used to have five phrasings now has three — indexes 3 and 4
 * would survive as text nobody wrote, still embedded and still retrievable.
 *
 * IT WAS "PAST THE END OF THE LIST" UNTIL TRANSLATIONS EXISTED, and that test
 * silently stopped working the moment translations joined `phrasings`: a
 * three-variant exemplar with twelve translations has a list of length 15, so
 * every authored row below 15 read as current and nothing was ever pruned. The
 * set of indexes actually written says the same thing about a shortened list and
 * keeps saying it once the list is no longer contiguous.
 *
 * `pruneTranslations` IS OFF WHEN THE TRANSLATIONS FILE IS ABSENT. Without it
 * the written set contains no index above 100, so every translation in the table
 * would read as stale and be deleted — an import run from a checkout that
 * happens not to have the file would quietly empty the non-French half of the
 * library. Absent means "nothing to say about translations", not "there are
 * none".
 */
async function removeStalePhrasings({ supabase, usable, idByKey, pruneTranslations }) {
  let removed = 0;

  for (const exemplar of usable) {
    const exemplarId = idByKey.get(exemplar.exemplarKey);
    if (!exemplarId) continue;

    const written = new Set(exemplar.phrasings.map((p) => p.index));

    const existing = await supabaseSelect(
      supabase,
      'support_exemplar_phrasings',
      { support_exemplar_id: exemplarId },
      'id,phrasing_index'
    );
    const stale = existing.filter((row) => {
      if (written.has(row.phrasing_index)) return false;
      return row.phrasing_index < TRANSLATION_INDEX_BASE || pruneTranslations;
    });
    if (stale.length === 0) continue;

    await supabaseDeleteWhereIn(
      supabase,
      'support_exemplar_phrasings',
      'id',
      stale.map((row) => row.id)
    );
    removed += stale.length;
  }

  return removed;
}

function report({ parsed, usable, skipped, warnings, translations }) {
  // COUNTED BY KIND, NOT BY LENGTH. `phrasings` holds the attached translations
  // too, so every arithmetic shortcut over its length — "everything after the
  // canonical is a variant", "length 1 means no variant" — started lying the day
  // translations were attached, and each would have gone on printing a
  // plausible-looking number.
  const authored = (u) => u.exemplar.phrasings.filter((p) => p.kind !== 'translated');
  const canonical = usable.length;
  const variants = usable.reduce((n, u) => n + authored(u).length, 0) - canonical;
  const translated = usable.reduce(
    (n, u) => n + u.exemplar.phrasings.filter((p) => p.kind === 'translated').length,
    0
  );

  console.log(
    `Parsed ${parsed.length} exemplar(s): ${usable.length} usable, ${skipped.length} skipped.\n` +
      `${canonical + variants + translated} phrasing(s) — ${canonical} canonical + ` +
      `${variants} real variant(s) + ${translated} translated.\n`
  );

  if (!translations?.hasFile) {
    console.log(
      'No Email-Example-Queries.translations.json: importing French only, and leaving\n' +
        'any translations already in the table alone. Run `npm run translate:exemplars`.\n'
    );
  } else if (translations.dropped > 0) {
    console.log(
      `${translations.dropped} translation(s) dropped as stale — re-run \`npm run translate:exemplars\`.\n`
    );
  }

  const bySubject = new Map();
  for (const { exemplar } of usable) {
    bySubject.set(exemplar.category, (bySubject.get(exemplar.category) || 0) + 1);
  }
  for (const [subject, count] of [...bySubject.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(3)}  ${subject}`);
  }

  // An exemplar with no needs cannot drive evidence collection, which is half
  // the point of the layer — worth seeing before it is approved.
  const needless = usable.filter((u) => u.exemplar.requirementNeeds.length === 0);
  if (needless.length > 0) {
    console.log(
      `\n${needless.length} exemplar(s) declare no needs: ` +
        needless.map((u) => u.exemplar.exemplarKey).join(', ')
    );
  }

  const noVariants = usable.filter((u) => authored(u).length === 1);
  if (noVariants.length > 0) {
    // The canonical question alone is the tidy register; without a real phrasing
    // these will match a messy email worst.
    console.log(
      `\n${noVariants.length} exemplar(s) have no real phrasing, only the canonical question: ` +
        noVariants.map((u) => u.exemplar.exemplarKey).join(', ')
    );
  }

  if (skipped.length > 0) {
    console.log('\nSkipped:');
    for (const { exemplar, problems } of skipped) {
      console.log(`  ${exemplar.exemplarKey} — ${problems.join(', ')}`);
    }
  }

  if (warnings.length > 0) {
    console.log('\nWarnings:');
    for (const warning of warnings) console.log(`  ${warning}`);
  }
}

function isDirectRun() {
  return import.meta.url === pathToFileURL(process.argv[1] || '').href;
}

import { readFileSync } from 'node:fs';
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
// Flags: --dry-run (parse and report, write nothing), --file=PATH.

const DEFAULT_FILE = new URL('../Email-Example-Queries.md', import.meta.url);

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

  report({ parsed, usable, skipped, warnings });

  if (args.dryRun) {
    console.log('\nDry run: nothing written.');
    return;
  }

  const config = loadConfig(loadEnv());
  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);

  const written = await write({ supabase, shopId, usable: usable.map((u) => u.exemplar) });
  console.log(
    `\nImported ${written.exemplars} exemplar(s) and ${written.phrasings} phrasing(s); ` +
      `removed ${written.removed} stale phrasing(s).`
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

async function write({ supabase, shopId, usable }) {
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

  const removed = await removeStalePhrasings({ supabase, usable, idByKey });

  return { exemplars: rows.length, phrasings: phrasingRows.length, removed };
}

/**
 * Drops phrasings past the end of a shortened list.
 *
 * The upsert overwrites indexes 0..n-1 but cannot know that an exemplar which
 * used to have five phrasings now has three — indexes 3 and 4 would survive as
 * text nobody wrote, still embedded and still retrievable.
 *
 * TRANSLATIONS ARE NOT AUTHORED HERE and must survive this. They are generated
 * from the phrasings rather than parsed out of the document, so by the only test
 * this function has — "is it past the end of the authored list?" — every one of
 * them looks stale. They live at `TRANSLATION_INDEX_BASE` and above precisely so
 * that the question can be asked of authored rows only.
 */
async function removeStalePhrasings({ supabase, usable, idByKey }) {
  let removed = 0;

  for (const exemplar of usable) {
    const exemplarId = idByKey.get(exemplar.exemplarKey);
    if (!exemplarId) continue;

    const existing = await supabaseSelect(
      supabase,
      'support_exemplar_phrasings',
      { support_exemplar_id: exemplarId },
      'id,phrasing_index'
    );
    const stale = existing.filter(
      (row) =>
        row.phrasing_index < TRANSLATION_INDEX_BASE &&
        row.phrasing_index >= exemplar.phrasings.length
    );
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

function report({ parsed, usable, skipped, warnings }) {
  const phrasings = usable.reduce((n, u) => n + u.exemplar.phrasings.length, 0);
  const variants = phrasings - usable.length;

  console.log(
    `Parsed ${parsed.length} exemplar(s): ${usable.length} usable, ${skipped.length} skipped.\n` +
      `${phrasings} phrasing(s) — ${usable.length} canonical + ${variants} real variant(s).\n`
  );

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

  const noVariants = usable.filter((u) => u.exemplar.phrasings.length === 1);
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

import { createSupabaseClient } from '../../../scripts/lib/supabase-rest-client.mjs';
import { createTicketRecord } from '../../../scripts/lib/ticket-record.mjs';

import { loadAgentConfig } from '../config.mjs';
import { logger } from '../lib/logger.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { toDraftingPrompt, toHumanBrief } from '../investigation/case-file.mjs';
import { summariseNeeds } from '../investigation/evidence-rules.mjs';
import { createInvestigationStack } from '../investigation/create-investigation.mjs';
import { raiseForCategorised, runInvestigation } from '../investigation/investigation-runner.mjs';
import { createSenderDirectoryStore } from '../ingestion/sender-directory.mjs';
import { createShopUsageRecording } from '../llm/usage-store.mjs';

// Runs the investigation pass on its own.
//
//   npm run investigate:dry-run                 # verdict per ticket, no writes
//   npm run investigate:dry-run -- --show        # plus the drafting prompt
//   npm run investigate:dry-run -- --brief       # plus the internal human brief
//   npm run investigate                          # the real pass
//   npm run investigate -- --limit 50
//   npm run investigate -- --backfill            # queue already-categorised tickets
//   npm run investigate -- --include-closed      # reach threads the queue moved past
//
// `--backfill` is needed twice: at rollout, because every existing ticket was
// categorised before this pass existed and the flag is only ever raised by the
// categoriser finishing; and again whenever a subject joins ENABLED_SUBJECTS,
// because its tickets were skipped and their flag cleared. It only ever raises
// the flag on OPEN tickets.
//
// `--include-closed` is the other half, and the two are not interchangeable.
// Auto-close retires a thread after 28 days of silence and leaves its pending
// flag raised, so on an imported historical corpus the queue fills with work no
// poll can claim — measured 2026-08-17 at 113 flagged tickets, 0 claimable. This
// widens the claim to them. The ticket's status is left where it is: a case file
// is a note about the thread, not a reason to reopen it.
//
// It is a person's decision because it is a bill: every ticket it reaches is a
// mid-tier run over mail nobody is waiting on. Pair it with `--limit`.
//
// `--show` is the acceptance test that no unit test can replace: each rendered
// dossier has to be something a writer could reply from without asking a
// follow-up question, with its four sections visibly separate. `--brief` adds
// what a customer must never see, which is how you check that `--show` does not
// contain it.

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const show = args.includes('--show');
const brief = args.includes('--brief');
const backfill = args.includes('--backfill');
const includeClosed = args.includes('--include-closed');
const limit = parseLimit(args);

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  if (!config.openaiApiKey) {
    console.error('OPENAI_API_KEY is not set — the investigation agent needs it to call tools.');
    process.exitCode = 1;
    return;
  }

  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);
  const record = createTicketRecord(supabase, { shopId });
  // A batch here is the most expensive thing this project runs — the mid tier,
  // once or twice per ticket, over as many tickets as the backlog holds. It gets
  // the same ledger as the worker's poll, or the one run big enough to be worth
  // costing is the one nothing records.
  const usage = createShopUsageRecording({ supabase, shopId, logger });
  const investigation = createInvestigationStack({
    supabase,
    shopId,
    config,
    logger,
    usageSink: usage.sink
  });
  const senderDirectoryStore = createSenderDirectoryStore(supabase);

  if (backfill) {
    const queued = await raiseForCategorised(record, { dryRun });
    console.log(
      `Backfill: ${queued} already-categorised ticket(s) ${dryRun ? 'would be' : ''} queued for investigation.`
    );
  }

  console.log(
    `\n${dryRun ? 'DRY RUN — nothing written.' : 'Investigating.'} Model: ${config.investigatorModel}` +
      ` · découpage : ${config.decomposerModel || 'désactivé'}` +
      `${includeClosed ? ' · fils clos inclus (statut inchangé)' : ''}\n`
  );

  // The evidence report, summed across the batch. This is the number the whole
  // step exists to produce: how much of what these tickets required was actually
  // obtained, and how often nothing even looked.
  const totalNeeds = {
    declared: 0,
    satisfied: 0,
    attempted: 0,
    unavailable: 0,
    not_attempted: 0,
    complete: 0
  };

  const totals = await runInvestigation({
    store: investigation.store,
    record,
    investigate: investigation.investigate,
    shopId,
    logger,
    dryRun,
    limit,
    anyStatus: includeClosed,
    // The same directory the worker loads, so a dry run reproduces what the
    // worker would have shown the model rather than a context-free version of it.
    senderDirectory: await senderDirectoryStore.load(shopId, {
      supportMailbox: config.graph.mailbox
    }),
    // Runs in a dry run too. It writes nothing itself, and leaving it out would
    // make the dry run stop reproducing the worker — the one thing it is for.
    retrieveExemplar: investigation.retrieveExemplar,
    onResult: ({ ticket, caseFile, level }) => {
      const needs = summariseNeeds(caseFile.evidenceGaps);
      totalNeeds.declared += needs.declared;
      totalNeeds.satisfied += needs.satisfied;
      totalNeeds.attempted += needs.attempted;
      totalNeeds.unavailable += needs.unavailable;
      totalNeeds.not_attempted += needs.not_attempted;
      totalNeeds.complete += needs.complete ? 1 : 0;

      console.log(
        `  ${ticket.id} · ${ticket.category}/${ticket.request_kind} → ${caseFile.verdict}` +
          ` (${caseFile.established.length} établi, ${caseFile.toolCalls.length} outils` +
          `, preuves ${needs.satisfied}/${needs.declared}` +
          `${needs.not_attempted > 0 ? ` ⚠ ${needs.not_attempted} non cherchés` : ''}` +
          `${caseFile.droppedClaims.length > 0 ? `, ${caseFile.droppedClaims.length} écartés` : ''}` +
          `${level !== ticket.level ? `, niveau ${ticket.level} → ${level}` : ''})`
      );
      if (show || brief) {
        console.log(`\n${indent(brief ? toHumanBrief(caseFile) : toDraftingPrompt(caseFile))}\n`);
      }
    }
  });

  console.log('\n' + JSON.stringify(totals, null, 1));
  console.log('\nPreuves attendues vs obtenues :\n' + JSON.stringify(totalNeeds, null, 1));

  // Reported on a dry run, stored only on a real one. The calls were billed
  // either way, so the number is worth printing; writing it is not, because a dry
  // run's whole contract is that it leaves no rows behind.
  const spent = await usage.flush({ write: !dryRun });
  if (spent.calls > 0) {
    console.log(
      `\nCoût : ${spent.calls} appel(s) modèle, ${spent.tokens} tokens` +
        `${dryRun ? ' (dry run — non enregistré)' : ` · ${spent.written} ligne(s) dans llm_usage`}.`
    );
  }
}

function indent(text) {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

function parseLimit(argv) {
  const index = argv.indexOf('--limit');
  if (index < 0) {
    return undefined;
  }
  const parsed = Number.parseInt(argv[index + 1], 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

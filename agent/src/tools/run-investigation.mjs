import { createSupabaseClient } from '../../../scripts/lib/supabase-rest-client.mjs';

import { loadAgentConfig } from '../config.mjs';
import { logger } from '../lib/logger.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { toDraftingPrompt, toHumanBrief } from '../investigation/case-file.mjs';
import { createInvestigationStack } from '../investigation/create-investigation.mjs';
import { runInvestigation } from '../investigation/investigation-runner.mjs';

// Runs the investigation pass on its own.
//
//   npm run investigate:dry-run                 # verdict per ticket, no writes
//   npm run investigate:dry-run -- --show        # plus the drafting prompt
//   npm run investigate:dry-run -- --brief       # plus the internal human brief
//   npm run investigate                          # the real pass
//   npm run investigate -- --limit 50
//   npm run investigate -- --backfill            # queue already-categorised tickets
//
// `--backfill` is needed twice: at rollout, because every existing ticket was
// categorised before this pass existed and the flag is only ever raised by the
// categoriser finishing; and again whenever a subject joins ENABLED_SUBJECTS,
// because its tickets were skipped and their flag cleared.
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
  const investigation = createInvestigationStack({ supabase, shopId, config, logger });

  if (backfill) {
    const queued = await investigation.store.raiseForCategorised(shopId, { dryRun });
    console.log(
      `Backfill: ${queued} already-categorised ticket(s) ${dryRun ? 'would be' : ''} queued for investigation.`
    );
  }

  console.log(`\n${dryRun ? 'DRY RUN — nothing written.' : 'Investigating.'} Model: ${config.investigatorModel}\n`);

  const totals = await runInvestigation({
    store: investigation.store,
    investigate: investigation.investigate,
    shopId,
    logger,
    dryRun,
    limit,
    onResult: ({ ticket, caseFile, level }) => {
      console.log(
        `  ${ticket.id} · ${ticket.category}/${ticket.request_kind} → ${caseFile.verdict}` +
          ` (${caseFile.established.length} établi, ${caseFile.toolCalls.length} outils` +
          `${caseFile.droppedClaims.length > 0 ? `, ${caseFile.droppedClaims.length} écartés` : ''}` +
          `${level !== ticket.level ? `, niveau ${ticket.level} → ${level}` : ''})`
      );
      if (show || brief) {
        console.log(`\n${indent(brief ? toHumanBrief(caseFile) : toDraftingPrompt(caseFile))}\n`);
      }
    }
  });

  console.log('\n' + JSON.stringify(totals, null, 1));
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

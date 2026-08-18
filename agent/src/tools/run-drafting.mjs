import { createSupabaseClient } from '../../../scripts/lib/supabase-rest-client.mjs';
import { createDraftRecord } from '../../../scripts/lib/draft-record.mjs';

import { loadAgentConfig } from '../config.mjs';
import { logger } from '../lib/logger.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { createOpenAIClient } from '../llm/openai-client.mjs';
import { createShopUsageRecording } from '../llm/usage-store.mjs';
import { createBrandVoiceStore } from '../drafting/brand-voice.mjs';
import { createDraftingStore, runDrafting } from '../drafting/draft-runner.mjs';

// Runs the drafting pass on its own.
//
//   npm run draft:dry-run                    # draft everything, store nothing
//   npm run draft:dry-run -- --show          # plus the reply itself
//   npm run draft -- --ticket <uuid> --show  # one ticket, end to end
//   npm run draft -- --limit 10
//   npm run draft -- --ticket <uuid> --redraft   # overwrite an existing draft
//
// `--redraft` is needed because the queue is DERIVED: a ticket leaves it as soon
// as a draft exists, which is the right default — a re-run must not spend the
// mid tier on replies nobody has read. But the loop of this phase is "change the
// prompt, look at the same tickets again", and a change to the mechanical checks
// leaves stored results describing a rule that no longer applies. Pair it with
// `--ticket` or `--limit`; on its own it re-drafts everything.
//
// NO MAILBOX IS INVOLVED. This reads stored rows and writes one; the review
// copy that puts a draft in front of a person is a separate, opt-in step. That
// separation is the point — the prompt is what gets iterated on here, and
// iterating on it should not put anything near an outbound mail path.
//
// `--show` is the acceptance test no unit test replaces: the reply has to be
// something you would sign. The check list printed under it says what was
// examined mechanically, which is a much smaller claim than "this is right".

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const show = args.includes('--show');
const redraft = args.includes('--redraft');
const limit = parseValue(args, '--limit', Number);
const ticketId = parseValue(args, '--ticket', String);

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  if (!config.openaiApiKey) {
    console.error('OPENAI_API_KEY is not set — the drafting agent needs it.');
    process.exitCode = 1;
    return;
  }

  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);

  // Loaded and checked before anything else runs. An unapproved brand voice is
  // a property of the whole run, and finding out on ticket 40 would mean 39
  // replies written in a voice nobody signed off.
  const brandVoice = await createBrandVoiceStore(supabase).load(shopId);

  const usage = createShopUsageRecording({ supabase, shopId, logger });
  const openai = createOpenAIClient({ apiKey: config.openaiApiKey, usageSink: usage.sink });

  console.log(
    `\n${dryRun ? 'DRY RUN — nothing written.' : 'Drafting.'} Model: ${config.draftingModel}` +
      ` · DRAFT_ONLY=${config.draftOnly} · livraison : ${config.draftDelivery}\n`
  );

  const totals = await runDrafting({
    store: createDraftingStore(supabase),
    draftRecord: createDraftRecord(supabase, { shopId }),
    openai,
    brandVoice,
    shopId,
    model: config.draftingModel,
    logger,
    limit,
    ticketId,
    dryRun,
    redraft,
    onDraft: ({ ticket, sourceVerdict, level, language, checksPassed, failedChecks, bodyText }) => {
      console.log(
        `  ${ticket.id} · ${sourceVerdict} · niveau ${level ?? '?'} · ${language}` +
          ` → ${bodyText.length} caractères` +
          `${checksPassed ? '' : ` ⚠ ${failedChecks.length} contrôle(s) en échec`}`
      );
      if (failedChecks.length > 0) {
        for (const failure of failedChecks) {
          console.log(`      ✗ ${failure}`);
        }
      }
      if (show) {
        console.log(`\n${indent(bodyText)}\n`);
      }
    }
  });

  console.log('\n' + JSON.stringify(totals, null, 1));

  // Same contract as the investigation CLI: the calls were billed either way, so
  // the number is printed on a dry run and stored only on a real one.
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

function parseValue(argv, flag, cast) {
  const index = argv.indexOf(flag);
  if (index < 0 || !argv[index + 1]) {
    return undefined;
  }
  const value = cast(argv[index + 1]);
  return Number.isNaN(value) ? undefined : value;
}

import { createSupabaseClient, supabaseSelect, supabaseSelectAll } from '../../../scripts/lib/supabase-rest-client.mjs';
import { T } from '../../../scripts/lib/tables.mjs';
import { createDraftRecord } from '../../../scripts/lib/draft-record.mjs';
import { estimateCost, resolveModelRates } from '../../../scripts/lib/llm-rates.mjs';
import { loadEnv } from '../../../scripts/lib/sync-config.mjs';

import { loadAgentConfig } from '../config.mjs';
import { logger } from '../lib/logger.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { createOpenAIClient } from '../llm/openai-client.mjs';
import { createShopUsageRecording } from '../llm/usage-store.mjs';
import { createBrandVoiceStore } from '../drafting/brand-voice.mjs';
import { createDraftingStore, runDrafting } from '../drafting/draft-runner.mjs';
import { readsAsClosure } from '../casework/closure.mjs';
import { createSenderDirectoryStore } from '../ingestion/sender-directory.mjs';
import { createCaseStateRecord } from '../../../scripts/lib/case-state-record.mjs';
import { loadDraftingContext } from '../drafting/draft-context.mjs';
import { CURSOR_KEYS } from '../ingestion/delta-poller.mjs';

// Runs the drafting pass on its own.
//
//   npm run draft:dry-run                    # draft everything, store nothing
//   npm run draft:dry-run -- --show          # plus the reply itself
//   npm run draft -- --ticket <uuid> --show  # one ticket, end to end
//   npm run draft -- --limit 10
//   npm run draft -- --ticket <uuid> --redraft   # overwrite an existing draft
//   npm run draft -- --dry-run --gates=poll      # what the worker would draft,
//                                                # and what it would cost; no model call
//
// `--gates=poll` applies the worker's gates (stage 6, `pollGate`): our turn, a
// customer message after the mailbox cutover, no pass pending. With `--dry-run`
// it calls no model at all and prints the count, the median tokens per draft
// from `llm_usage` and the cost at `llm-rates.mjs` prices (LLM_RATES overrides
// them). This is the check before DRAFT_IN_POLL is switched on.
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
const gates = args.includes('--gates=poll') ? 'poll' : 'manual';
const estimateOnly = dryRun && gates === 'poll';

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  if (!config.openaiApiKey && !estimateOnly) {
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

  // WHO EACH SENDER IS, loaded once for the run. The same table the ingestion
  // gates read; here it decides whether a message renders as the customer.
  const senderDirectory = await createSenderDirectoryStore(supabase).load(shopId, {
    supportMailbox: config.graph.mailbox
  });

  // The mailbox cutover, for the poll gates: nothing imported before it is drafted to.
  const cursors = (await supabaseSelect(supabase, T.SHOPS, { id: shopId }, 'sync_cursors'))[0]?.sync_cursors ?? {};
  const cutoverAt = cursors[CURSOR_KEYS.cutoverAt] ?? null;
  if (gates === 'poll' && !cutoverAt) {
    console.error('No mail_ingest_cutover_at: a full mailbox read has not completed, so the poll gates cannot apply.');
    process.exitCode = 1;
    return;
  }

  const usage = createShopUsageRecording({ supabase, shopId, logger });
  const openai = createOpenAIClient({ apiKey: config.openaiApiKey, usageSink: usage.sink });

  console.log(
    `\n${estimateOnly ? 'ESTIMATE — no model call, nothing written.' : dryRun ? 'DRY RUN — nothing written.' : 'Drafting.'}` +
      ` Model: ${config.draftingModel} · gates: ${gates}${gates === 'poll' ? ` (cutover ${cutoverAt})` : ''}` +
      ` · DRAFT_ONLY=${config.draftOnly}` +
      ` · DRAFT_ONLY_COSMETOVIGILANCE=${config.draftOnlyCosmetovigilance}` +
      ` · livraison : ${config.draftDelivery}\n`
  );

  const totals = await runDrafting({
    store: createDraftingStore(supabase, { caseStateStore: createCaseStateRecord(supabase, { shopId }) }),
    draftRecord: createDraftRecord(supabase, { shopId }),
    openai,
    brandVoice,
    shopId,
    model: config.draftingModel,
    ...(await loadDraftingContext(supabase, shopId, logger)),
    // Null when AGENT_CLOSURE_MODEL is blank, and null means no closure is ever
    // detected — the switch is the absence of the reader, not a flag inside it.
    senderDirectory,
    closureReader: config.closureModel
      ? ({ message, ticketId, senderDirectory: directory }) =>
          readsAsClosure({ openai, model: config.closureModel, message, senderDirectory: directory, ticketId, logger })
      : null,
    cosmetovigilanceDraftOnly: config.draftOnlyCosmetovigilance,
    logger,
    limit,
    ticketId,
    dryRun,
    redraft,
    gates,
    cutoverAt,
    estimateOnly,
    onDraft: ({ ticket, estimate, sourceVerdict, level, language, checksPassed, failedChecks, warnings = [], bodyText, caseVersion, autoSendBlockers = [] }) => {
      if (estimate) {
        console.log(`  ${ticket.id} · ${sourceVerdict} · niveau ${level ?? '?'} · version ${caseVersion ?? '?'} → would be drafted`);
        return;
      }
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
      for (const warning of warnings) {
        console.log(`      ⚠ ${warning}`);
      }
      // Why it would not send itself, were auto-send on (draft-rules.mjs).
      console.log(
        autoSendBlockers.length === 0
          ? '      envoi auto : possible'
          : `      envoi auto : bloqué — ${autoSendBlockers.map((b) => (b.detail == null ? b.reason : `${b.reason} (${b.detail})`)).join(' · ')}`
      );
      if (show) {
        console.log(`\n${indent(bodyText)}\n`);
      }
    }
  });

  console.log('\n' + JSON.stringify(totals, null, 1));

  if (estimateOnly) {
    await printEstimate({ supabase, shopId, config, totals: { ...totals, cutoverAt } });
    return;
  }

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

/**
 * The cost of switching DRAFT_IN_POLL on, from the counts above and what drafts
 * have cost so far. No estimate by hand (decided 2026-09-26): the median input
 * and output tokens of the drafting pass's own `llm_usage` rows, times the
 * current rate. The closure reader's small call is not included.
 */
async function printEstimate({ supabase, shopId, config, totals }) {
  const rows = await supabaseSelectAll(
    supabase,
    T.LLM_USAGE,
    { shop_id: shopId, pass: 'draft', succeeded: true },
    'input_tokens,output_tokens,model',
    { order: 'id.asc' }
  );
  const median = (values) => {
    const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (sorted.length === 0) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  };
  const input = median(rows.map((row) => Number(row.input_tokens)));
  const output = median(rows.map((row) => Number(row.output_tokens)));
  const cutoverSkips = totals.skippedBy?.before_cutover ?? 0;

  // OUR TURN, BUT NOT YET INVESTIGATED. A draft needs a case file, so a new
  // customer message the worker has not categorised and investigated yet is not
  // a candidate above. Counted here so « 0 drafts » cannot hide a backlog: these
  // are drafted in the poll once the passes before drafting have run.
  const ourTurn = await supabaseSelectAll(
    supabase,
    T.CASE_CURRENT,
    { shop_id: shopId, next_actor: 'support', as_of_at: { operator: 'gte', value: new Date(totals.cutoverAt).toISOString() } },
    'ticket_id',
    { order: 'ticket_id.asc' }
  );
  const waiting = ourTurn.length - totals.considered;

  console.log('\nWhat switching DRAFT_IN_POLL on would do now:');
  console.log(`  our turn on a message since the cutover: ${ourTurn.length}`);
  console.log(`    of which with a case file (considered): ${totals.considered}`);
  if (waiting > 0) {
    console.log(`    of which still waiting for categorisation or investigation: ${waiting} (no draft until the worker has read them)`);
  }
  console.log(`  eligible under the cutover rule: ${totals.considered - cutoverSkips}`);
  console.log(`  drafts that would be written, after every gate: ${totals.drafted}`);
  if (input === null || output === null) {
    console.log('  no drafting rows in llm_usage yet: no token median, so no cost estimate.');
    return;
  }
  const rates = resolveModelRates(loadEnv());
  const one = estimateCost({ model: config.draftingModel, inputTokens: input, outputTokens: output, rates });
  console.log(`  median tokens per draft, from ${rows.length} drafting call(s): ${input} in, ${output} out`);
  if (!one.rated) {
    console.log(`  no rate for ${config.draftingModel} in llm-rates.mjs or LLM_RATES: cost not estimated.`);
    return;
  }
  console.log(
    `  estimated cost: ${totals.drafted} × $${one.totalUsd.toFixed(4)} = $${(totals.drafted * one.totalUsd).toFixed(2)}` +
      ` (${config.draftingModel} at $${rates[config.draftingModel].input}/M in, $${rates[config.draftingModel].output}/M out)`
  );
  if (waiting > 0) {
    const most = totals.drafted + waiting;
    console.log(`  at most, once the waiting ones are investigated: ${most} × $${one.totalUsd.toFixed(4)} = $${(most * one.totalUsd).toFixed(2)}`);
  }
}

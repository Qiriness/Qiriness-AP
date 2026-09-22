import { createSupabaseClient, supabaseSelect } from '../../../scripts/lib/supabase-rest-client.mjs';
import { T } from '../../../scripts/lib/tables.mjs';
import { toParameterMap } from '../../../scripts/lib/parameters.mjs';
import { createDraftRecord } from '../../../scripts/lib/draft-record.mjs';

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

  // WHO EACH SENDER IS, loaded once for the run. The same table the ingestion
  // gates read; here it decides whether a message renders as the customer.
  const senderDirectory = await createSenderDirectoryStore(supabase).load(shopId, {
    supportMailbox: config.graph.mailbox
  });

  const usage = createShopUsageRecording({ supabase, shopId, logger });
  const openai = createOpenAIClient({ apiKey: config.openaiApiKey, usageSink: usage.sink });

  console.log(
    `\n${dryRun ? 'DRY RUN — nothing written.' : 'Drafting.'} Model: ${config.draftingModel}` +
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
    parameters: await loadParametersFor(supabase, shopId, logger),
    offerableCodes: await loadOfferableCodesFor(supabase, shopId, logger),
    pinnedArticles: await loadPinnedArticlesFor(supabase, shopId, logger),
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

/**
 * The numbers a skeleton may quote.
 *
 * Loaded here rather than taken from the investigation stack, which this CLI
 * does not build: drafting reads stored case files and needs no tools. A failure
 * degrades to no parameters, which drops any skeleton quoting one — the
 * behaviour before skeletons existed.
 */
/**
 * The codes a rule is still allowed to hand out, as a set of the code strings.
 *
 * TWO CONDITIONS, BOTH REQUIRED. The promotion must be ACTIVE in Shopify, and an
 * operator must have marked it offerable — a code that expired and a code that
 * was never meant for customers are different mistakes and this is the one place
 * that can catch either.
 *
 * A FAILURE RETURNS AN EMPTY SET, which drops every offer rather than sending a
 * code nobody checked. That is the safe direction for the one field in a reply
 * that is a key rather than prose: a reply missing an offer is incomplete, a
 * reply carrying a dead code is a customer typing it in and writing back.
 */
async function loadOfferableCodesFor(supabase, shopId, logger) {
  try {
    const rows = await supabaseSelect(
      supabase,
      T.PROMOTIONS,
      { shop_id: shopId, status: 'ACTIVE', offerable_in_replies: true },
      'codes'
    );
    const codes = new Set();
    for (const row of rows || []) {
      for (const entry of Array.isArray(row.codes) ? row.codes : []) {
        const code = String(entry?.code ?? '').trim();
        if (code) codes.add(code);
      }
    }
    return codes;
  } catch (error) {
    logger?.warn?.('draft.offerable_codes_load_failed', { reason: error.message });
    return new Set();
  }
}

/**
 * The articles approved rules pin, by document id.
 *
 * TWO READS RATHER THAN A JOIN, because PostgREST embeds are a different shape
 * per relationship and the id list here is tiny — at most one per rule, and
 * there are 107 rules. Approved rules only, matching `loadAnswers`: a draft
 * rule is not one the agent can be steered by, so its article is not one worth
 * loading.
 *
 * APPROVAL IS RE-CHECKED HERE and not trusted from the rule, which is the whole
 * point of resolving at drafting time — an operator can unapprove an article
 * without touching the rule that cites it.
 *
 * NEVER FAILS A DRAFT. An empty map drops every pin, which degrades to the
 * behaviour before pinning existed.
 */
async function loadPinnedArticlesFor(supabase, shopId, logger) {
  try {
    const rules = await supabaseSelect(
      supabase,
      T.SUPPORT_ANSWERS,
      { shop_id: shopId, approval_status: 'approved' },
      'knowledge_document_id'
    );
    const ids = [...new Set((rules || []).map((row) => row.knowledge_document_id).filter(Boolean))];
    if (ids.length === 0) {
      return new Map();
    }
    const documents = await supabaseSelect(
      supabase,
      T.KNOWLEDGE_DOCUMENTS,
      { shop_id: shopId, approval_status: 'approved' },
      'id,title,content_text,deleted_at'
    );
    const wanted = new Set(ids);
    const map = new Map();
    for (const doc of documents || []) {
      if (!wanted.has(doc.id) || doc.deleted_at) continue;
      map.set(doc.id, { title: doc.title ?? null, text: doc.content_text ?? '' });
    }
    return map;
  } catch (error) {
    logger?.warn?.('draft.pinned_articles_load_failed', { reason: error.message });
    return new Map();
  }
}

async function loadParametersFor(supabase, shopId, logger) {
  try {
    return toParameterMap(
      await supabaseSelect(supabase, T.SUPPORT_PARAMETERS, { shop_id: shopId }, 'parameter_key,value')
    );
  } catch (error) {
    logger?.warn?.('draft.parameters_load_failed', { reason: error.message });
    return new Map();
  }
}

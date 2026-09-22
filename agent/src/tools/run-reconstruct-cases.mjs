import { writeFileSync } from 'node:fs';

import { createSupabaseClient, supabaseSelect } from '../../../scripts/lib/supabase-rest-client.mjs';
import { COLUMNS, T } from '../../../scripts/lib/tables.mjs';
import { createTicketRecord } from '../../../scripts/lib/ticket-record.mjs';

import { loadAgentConfig } from '../config.mjs';
import { logger } from '../lib/logger.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { createOpenAIClient } from '../llm/openai-client.mjs';
import { createShopUsageRecording } from '../llm/usage-store.mjs';
import { reconstructCase } from '../casework/reconstruct.mjs';
import { createSenderDirectoryStore } from '../ingestion/sender-directory.mjs';

// Reads finished threads and says where each case stands.
//
//   npm run cases:reconstruct                      # every multi-message thread
//   npm run cases:reconstruct -- --min-inbound 2   # how many customer messages (default 2)
//   npm run cases:reconstruct -- --ticket <uuid>
//   npm run cases:reconstruct -- --limit 5
//   npm run cases:reconstruct -- --json out.json   # the rows, for a review pass
//
// IT WRITES NOTHING, and that is structural. No record module is constructed
// here and no store is passed: there is no write path to forget to guard. The
// one row it does leave behind is the `llm_usage` line the transport records for
// every model call in this worker, because the call was billed either way.
//
// WHY `--min-inbound 2` IS THE DEFAULT. A thread with one customer message and
// no reply has no trajectory to reconstruct — the case file already says
// everything this could. 133 of 172 tickets are exactly that, and running them
// would spend 133 calls to be told so.
//
// THE OUTPUT IS A REVIEW ARTEFACT, NOT AN INPUT. Nothing downstream reads these
// rows. They exist to be corrected by a person and become the labelled set a
// regression suite can be built on, which is the only way out of the circularity
// in judging a reconstruction against a reconstruction.

const args = process.argv.slice(2);
const ticketId = parseValue(args, '--ticket', String);
const limit = parseValue(args, '--limit', Number);
const jsonPath = parseValue(args, '--json', String);
const minInbound = parseValue(args, '--min-inbound', Number) ?? 2;

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  if (!config.openaiApiKey) {
    console.error('OPENAI_API_KEY is not set — reconstruction reads with a model.');
    process.exitCode = 1;
    return;
  }

  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);
  // A READER, and deliberately the only thing built from the record module. Its
  // write half is never called because nothing here has a reason to.
  const record = createTicketRecord(supabase, { shopId });

  const situations = await loadSituations(supabase, shopId);
  if (situations.length === 0) {
    console.error('No approved situations — `situation_key` would be null on every row.');
    process.exitCode = 1;
    return;
  }

  // WHO EACH SENDER IS. Without it every inbound message reads as the
  // customer, and `45c0a2b7` — internal coordination about three different
  // customers — reconstructs as one customer's case.
  const senderDirectory = await createSenderDirectoryStore(supabase).load(shopId, {
    supportMailbox: config.graph.mailbox
  });

  const usage = createShopUsageRecording({ supabase, shopId, logger });
  const openai = createOpenAIClient({ apiKey: config.openaiApiKey, usageSink: usage.sink });
  const model = config.reconstructionModel;

  const tickets = await loadTickets(supabase, shopId, { ticketId });
  const rows = [];

  console.log(
    `\nReconstruction — READ ONLY. Model: ${model} · ${situations.length} situations` +
      ` · au moins ${minInbound} message(s) du client\n`
  );

  for (const ticket of tickets) {
    const conversation = await record.conversation(ticket.id, { columns: COLUMNS.threadForDrafting });
    const inbound = conversation.filter((message) => message.direction !== 'outbound').length;
    if (inbound < minInbound) continue;
    if (typeof limit === 'number' && rows.length >= limit) break;

    const row = await reconstructCase({ openai, model, ticket, conversation, situations, senderDirectory, logger });
    rows.push(row);
    print(row);
  }

  if (rows.length === 0) {
    console.log('Aucun fil ne correspond.');
  }

  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify(rows, null, 2), 'utf8');
    console.log(`\n${rows.length} ligne(s) écrite(s) dans ${jsonPath}`);
  }

  summarise(rows);

  // The calls were billed whether or not anything else happened, so they are
  // recorded — the one row this pass leaves behind, and the reason the header
  // says READ ONLY rather than WRITES NOTHING.
  const spend = await usage.flush();
  console.log(`Coût : ${spend.calls} appel(s) modèle, ${spend.tokens} tokens · ${spend.written} ligne(s) dans llm_usage.`);
}

function print(row) {
  const head = `  ${row.ticketId?.slice(0, 8)} · ${row.inbound} reçus / ${row.outbound} envoyés`;
  if (row.error) {
    console.log(`${head} · ÉCHEC : ${row.error}`);
    return;
  }
  console.log(`${head} · ${row.situationKey || 'aucune situation'}${row.openIssue ? '' : ' · rien en suspens'}`);
  if (row.caseSummary) console.log(`      ${row.caseSummary}`);
  if (row.rejectedSituationKey) console.log(`      ⚠ clé inventée, écartée : ${row.rejectedSituationKey}`);
  for (const ask of row.askedByQiriness) {
    console.log(`      demandé : ${ask.what} — ${ask.answered ? 'répondu' : 'SANS RÉPONSE'}`);
  }
  for (const c of row.commitments) console.log(`      promis : ${c.what} [${c.status}]`);
  for (const p of row.pendingInternalActions) console.log(`      à faire : ${p}`);
  console.log(`      remboursement — le fil dit : ${row.claims.refund} · la commande montre : ${row.backend.refund}`);
  for (const c of row.contradictions) console.log(`      ⚠ ${c}`);
}

function summarise(rows) {
  const done = rows.filter((row) => !row.error);
  const tally = {};
  for (const row of done) {
    const key = row.situationKey || '(aucune)';
    tally[key] = (tally[key] || 0) + 1;
  }
  console.log(
    `\n${rows.length} fil(s) · ${rows.length - done.length} échec(s)` +
      ` · ${done.filter((r) => r.openIssue).length} avec un point en suspens` +
      ` · ${done.filter((r) => r.contradictions.length > 0).length} contradiction(s) fil/commande` +
      ` · ${done.filter((r) => r.rejectedSituationKey).length} clé(s) inventée(s)`
  );
  console.log('situations :', Object.entries(tally).map(([k, n]) => `${k}=${n}`).join(' · ') || '(aucune)');
}

/**
 * The library the model must choose from — approved rows only.
 *
 * A draft situation is one a person is still writing; offering it here would put
 * a key into a review artefact that the rules layer cannot act on.
 */
async function loadSituations(supabase, shopId) {
  return supabaseSelect(
    supabase,
    T.SUPPORT_EXEMPLARS,
    { shop_id: shopId, approval_status: 'approved', deleted_at: { operator: 'is', value: 'null' } },
    'exemplar_key,canonical_question,category',
    { order: 'exemplar_key.asc' }
  );
}

/**
 * Every live ticket, closed ones included — which is the whole corpus this is for.
 *
 * No status filter, and no flag: a reconstruction is a note about a finished
 * thread, so the queue this pass does not have is the queue it must not need.
 */
async function loadTickets(supabase, shopId, { ticketId }) {
  const filters = {
    shop_id: shopId,
    deleted_at: { operator: 'is', value: 'null' },
    archived_at: { operator: 'is', value: 'null' }
  };
  if (ticketId) filters.id = ticketId;
  return supabaseSelect(supabase, T.TICKETS, filters, COLUMNS.ticketForInvestigation, {
    order: 'first_message_at.asc'
  });
}

function parseValue(argv, flag, cast) {
  const index = argv.indexOf(flag);
  if (index === -1 || index === argv.length - 1) return undefined;
  const value = cast(argv[index + 1]);
  return Number.isNaN(value) ? undefined : value;
}

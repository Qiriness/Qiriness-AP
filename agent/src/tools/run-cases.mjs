import { createSupabaseClient, supabaseSelectAll } from '../../../scripts/lib/supabase-rest-client.mjs';
import { COLUMNS, T } from '../../../scripts/lib/tables.mjs';
import { createTicketRecord } from '../../../scripts/lib/ticket-record.mjs';
import { createCaseRecord } from '../../../scripts/lib/case-record.mjs';
import { createSnoozeRecord } from '../../../scripts/lib/snooze-record.mjs';

import { loadAgentConfig } from '../config.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { createSenderDirectoryStore } from '../ingestion/sender-directory.mjs';
import { CASE_LINK_WINDOW_DAYS, createCaseLinkStore, runCaseLinking } from '../cases/case-linker-runner.mjs';
import { decideLink } from '../cases/case-link-rules.mjs';
import { createCaseLinker } from '../cases/case-linker-model.mjs';
import { createOpenAIClient } from '../llm/openai-client.mjs';
import { noopUsageSink } from '../llm/usage-sink.mjs';

// Cases (61_cases.sql), by hand.
//
//   npm run cases:link             # the `link` pass, once, on pending threads
//   npm run cases:link:dry-run     # what it would decide, nothing written
//   npm run cases:link -- --open [--dry-run] [--with-model]
//                                  # the Queue and Backlog threads and their customers'
//                                  # earlier threads, re-decided once
//                                  # (they predate 61 and were marked decided)
//   npm run cases:targets          # recompute every case's reply target
//   npm run cases:replay           # the rules over the stored corpus, read-only
//   npm run cases:replay -- --with-model   # ...asking the Case Linker on ambiguous threads (costs calls)
//
// REPLAY IS THE CHECK BEFORE CASE_LINKER_ENABLED=true. Each thread is decided
// as if it had just arrived: only the customer's EARLIER threads are
// candidates. Nothing is written. Every link and every ambiguous thread is
// listed with the ticket ids, so each can be read by hand.

const args = process.argv.slice(2);
const command = args[0];
const dryRun = args.includes('--dry-run');
const withModel = args.includes('--with-model');
const openOnly = args.includes('--open');
const limitArg = args.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : null;

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);
  const tickets = createTicketRecord(supabase, { shopId });
  const cases = createCaseRecord(supabase, { shopId, tickets });
  const senderDirectory = await createSenderDirectoryStore(supabase).load(shopId, { supportMailbox: config.graph.mailbox });

  if (command === 'targets') return targets({ supabase, shopId, cases });
  if (command === 'link') return link({ supabase, shopId, tickets, cases, senderDirectory, config });
  if (command === 'replay') return replay({ supabase, shopId, tickets, cases, senderDirectory, config });
  throw new Error('Usage: run-cases.mjs <link|targets|replay> [--dry-run] [--open] [--with-model] [--limit=N]');
}

async function targets({ supabase, shopId, cases }) {
  const rows = await supabaseSelectAll(supabase, T.CASES, { shop_id: shopId }, 'id');
  let owed = 0;
  for (const [index, row] of rows.entries()) {
    if (await cases.refreshTarget(row.id)) owed += 1;
    if ((index + 1) % 100 === 0) console.log(`  ${index + 1} / ${rows.length}`);
  }
  console.log(`\n${rows.length} cases, ${owed} with a customer message still owed a reply.`);
}

async function link({ supabase, shopId, tickets, cases, senderDirectory, config }) {
  const linkCase = linkerFor(config, { force: withModel });
  const snoozes = createSnoozeRecord(supabase, { shopId });
  const storeFor = (before = null) => createCaseLinkStore(supabase, { shopId, tickets, cases, senderDirectory, snoozes, before });
  let store = storeFor();
  if (openOnly) {
    // --open: the Queue and Backlog threads, already `decided` by migration 61,
    // decided again as if each had just arrived (against the customer's
    // EARLIER threads only, as `replay` checked). Oldest first, so a thread
    // linked here is in its case when a later one is decided.
    const open = await openThreads({ supabase, shopId });
    store = {
      ...store,
      pending: async () => open,
      contextFor: (ticket, options) => storeFor(ticket.first_message_at).contextFor(ticket, options)
    };
  }
  const result = await runCaseLinking({
    store,
    cases,
    linkCase,
    dryRun,
    limit: limit ?? 500
  });
  const { decisions, ...summary } = result;
  console.log(`\n${dryRun ? 'DRY RUN — nothing written.' : 'Decided.'}`, summary);
  for (const decision of decisions.filter((d) => d.decision === 'link' || d.method === 'model_off')) {
    console.log(`  ${decision.method.padEnd(14)} ${decision.ticketId} -> ${decision.toCaseId}  candidates=${decision.candidates.length}`);
  }
}

/**
 * What the dashboard's Queue and Backlog show between them: consumer threads
 * (no `sender_label`) not resolved or closed and not snoozed. PLUS each of
 * those customers' earlier threads within the link window, closed ones
 * included: decided oldest first, they are in their case by the time the open
 * thread is decided, so the open thread joins the whole case and not one
 * fragment of it. Moving a closed thread changes its case only (linking
 * reopens nothing it did not investigate).
 *
 * A thread already sharing a case (a duplicate folded in by 61) is left
 * alone: re-deciding one would move it out of its case, away from the rest.
 */
async function openThreads({ supabase, shopId }) {
  const live = { shop_id: shopId, deleted_at: { operator: 'is', value: 'null' }, sender_label: { operator: 'is', value: 'null' } };
  const rows = await supabaseSelectAll(supabase, T.TICKETS, live, COLUMNS.ticketForCaseLink, { order: 'first_message_at.asc' });
  const snoozed = new Set(
    (await supabaseSelectAll(supabase, T.TICKET_SNOOZES, { shop_id: shopId, woke_at: { operator: 'is', value: 'null' } }, 'ticket_id')).map((row) => row.ticket_id)
  );
  const isOpen = (row) => !['resolved', 'closed'].includes(row.status) && !snoozed.has(row.id);
  const open = rows.filter((row) => row.first_message_at && isOpen(row)).slice(0, limit ?? undefined);

  // The earliest open thread of each customer, and how far back that reaches.
  const reach = new Map();
  for (const row of open) {
    if (!row.requester_email_hash || reach.has(row.requester_email_hash)) continue;
    reach.set(row.requester_email_hash, Date.parse(row.first_message_at) - CASE_LINK_WINDOW_DAYS * 86400000);
  }
  const threadsPerCase = new Map();
  for (const row of rows) threadsPerCase.set(row.case_id, (threadsPerCase.get(row.case_id) ?? 0) + 1);

  const openIds = new Set(open.map((row) => row.id));
  const selected = rows.filter((row) => {
    if (!row.first_message_at || threadsPerCase.get(row.case_id) > 1) return false;
    if (openIds.has(row.id)) return true;
    const from = reach.get(row.requester_email_hash);
    return from !== undefined && Date.parse(row.first_message_at) >= from && !isOpen(row);
  });
  console.log(`${open.length} Queue and Backlog threads; ${selected.length - selected.filter((r) => openIds.has(r.id)).length} earlier threads of the same customers; ${open.filter((r) => threadsPerCase.get(r.case_id) > 1).length} open threads skipped (already share a case).`);
  return selected;
}

async function replay({ supabase, shopId, tickets, cases, senderDirectory, config }) {
  const linkCase = withModel ? linkerFor(config, { force: true }) : null;
  const families = await cases.families();
  const all = await supabaseSelectAll(
    supabase,
    T.TICKETS,
    { shop_id: shopId, deleted_at: { operator: 'is', value: 'null' } },
    'id,case_id,subject,status,investigated_at,category,request_kind,requester_email_hash,customer_id,sender_label,shopify_order_number,resolved_context,first_message_at,last_message_at,duplicate_of_ticket_id',
    { order: 'first_message_at.asc' }
  );
  const subjectOf = new Map(all.map((t) => [t.id, t.subject]));
  const firstTicketOfCase = new Map();
  for (const ticket of all) if (!firstTicketOfCase.has(ticket.case_id)) firstTicketOfCase.set(ticket.case_id, ticket.id);

  const counts = {};
  const listed = [];
  // Cumulative: a thread the replay linked is in its target case for every
  // later thread, as the live pass would have left it. Without this, a third
  // thread on one parcel sees the first two as two cases and reads ambiguous.
  const replayedCase = new Map();
  const sample = limit ? all.slice(-limit) : all;
  for (const ticket of sample) {
    if (!ticket.first_message_at) continue;
    const asOf = new Date(ticket.first_message_at);
    const store = createCaseLinkStore(supabase, { shopId, tickets, cases, senderDirectory, now: () => asOf, before: ticket.first_message_at, caseOf: (id) => replayedCase.get(id) });
    const context = await store.contextFor(ticket, { families });
    let outcome = decideLink({ thread: context.thread, candidates: context.candidates, transitions: families.transitions });
    if (outcome.decision === 'ambiguous' && linkCase) {
      const answer = await linkCase({ ticketId: ticket.id, subject: ticket.subject, body: context.opening?.body_text ?? '', identifiers: context.thread, candidates: context.candidates });
      outcome = { ...outcome, model: answer.answer };
      if (answer.caseId) outcome.caseId = answer.caseId;
    }
    if (outcome.caseId) replayedCase.set(ticket.id, outcome.caseId);
    const key = outcome.decision === 'ambiguous' ? `ambiguous${outcome.model ? ` -> ${outcome.model.startsWith('LINK') ? 'model link' : 'model new'}` : ''}` : outcome.method;
    counts[key] = (counts[key] ?? 0) + 1;
    if (outcome.decision !== 'new_case') listed.push({ ticket, outcome, candidates: context.candidates });
  }

  console.log('\nREPLAY — nothing written. Each thread decided as if it had just arrived.\n');
  console.log(counts);
  console.log('\nTo read by hand:');
  for (const { ticket, outcome, candidates } of listed) {
    const target = outcome.caseId ?? null;
    console.log(`\n${outcome.decision === 'link' ? `LINK (${outcome.method})` : 'AMBIGUOUS'}  ${ticket.first_message_at?.slice(0, 10)}  ${ticket.id}  « ${ticket.subject ?? ''} »`);
    if (target) console.log(`   -> case of ${firstTicketOfCase.get(target)}  « ${subjectOf.get(firstTicketOfCase.get(target)) ?? ''} »`);
    for (const candidate of candidates) {
      console.log(`   candidate ${candidate.caseId}  [${candidate.reasons.join(', ')}]  ${candidate.summary}`);
    }
    if (outcome.model) console.log(`   model: ${outcome.model}`);
  }
}

function linkerFor(config, { force = false } = {}) {
  if (!force && !config.caseLinkerEnabled) return null;
  if (!config.openaiApiKey || !config.caseLinkerModel) return null;
  const openai = createOpenAIClient({ apiKey: config.openaiApiKey, usageSink: noopUsageSink });
  return createCaseLinker(openai, { model: config.caseLinkerModel });
}

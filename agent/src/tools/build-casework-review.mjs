import { writeFileSync } from 'node:fs';

import { createSupabaseClient, supabaseSelect } from '../../../scripts/lib/supabase-rest-client.mjs';
import { splitQuotedReply } from '../../../scripts/lib/quoted-reply.mjs';
import { COLUMNS, T } from '../../../scripts/lib/tables.mjs';
import { createTicketRecord } from '../../../scripts/lib/ticket-record.mjs';

import { loadAgentConfig } from '../config.mjs';
import { logger } from '../lib/logger.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { createOpenAIClient } from '../llm/openai-client.mjs';
import { readCase } from '../casework/case-manager.mjs';
import { pendingAfter } from '../casework/case-manager-rules.mjs';
import { createSenderDirectoryStore, senderRoleName } from '../ingestion/sender-directory.mjs';

import { DEFAULT_GROUPS, cutsFor, threadGroup, threadUpTo } from '../../eval/casework-cuts.mjs';
import { renderReviewPage } from '../../eval/casework-review-page.mjs';

// Builds the page the multi-turn labelled set is written on.
//
//   npm run cases:label -- --count                  # how many threads and cuts, no model call
//   npm run cases:label                             # the page, nothing pre-filled
//   npm run cases:label -- --prefill                # the current Case Manager suggests labels
//   npm run cases:label -- --groups customer_followup,other_sender,replied_once
//   npm run cases:label -- --out casework-review.html
//
// READ ONLY. No record write path is called, and `--prefill` runs the Case
// Manager's own `readCase` without a usage sink, as `eval:closure` does: the
// suggestions are a labelling aid, not production spend.
//
// THE OUTPUT QUOTES REAL MAIL. The default name matches `*-review.html`, which
// is gitignored; keep it that way. What comes back from the page — the export —
// carries ids and choices only.
//
// A SUGGESTION IS NOT A LABEL. Pre-filled values are shown as suggestions and
// the page counts a message as labelled only once a person has set the case
// state and the next action, neither of which is ever pre-filled.

const args = process.argv.slice(2);
const countOnly = args.includes('--count');
const prefill = args.includes('--prefill');
const outPath = value('--out') || 'casework-review.html';
const groups = (value('--groups') || DEFAULT_GROUPS.join(',')).split(',').map((g) => g.trim()).filter(Boolean);

function value(flag) {
  const index = args.indexOf(flag);
  return index === -1 || index === args.length - 1 ? undefined : args[index + 1];
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  if (prefill && (!config.openaiApiKey || !config.caseworkModel)) {
    console.error('--prefill needs OPENAI_API_KEY and a non-empty AGENT_CASEWORK_MODEL.');
    process.exitCode = 1;
    return;
  }

  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);
  const record = createTicketRecord(supabase, { shopId });
  const senderDirectory = await createSenderDirectoryStore(supabase).load(shopId, {
    supportMailbox: config.graph.mailbox
  });

  const tickets = await supabaseSelect(
    supabase,
    T.TICKETS,
    { shop_id: shopId, deleted_at: { operator: 'is', value: 'null' }, archived_at: { operator: 'is', value: 'null' } },
    'id,subject,category,request_kind,first_message_at',
    { order: 'first_message_at.asc' }
  );

  const tally = { customer_followup: [0, 0], other_sender: [0, 0], replied_once: [0, 0] };
  const selected = [];
  for (const ticket of tickets) {
    const conversation = await record.conversation(ticket.id, { columns: COLUMNS.threadForDrafting });
    const group = threadGroup(conversation, senderDirectory);
    if (!group) continue;
    const cuts = cutsFor(conversation, senderDirectory);
    tally[group][0] += 1;
    tally[group][1] += cuts.length;
    if (groups.includes(group)) selected.push({ ticket, conversation, group, cuts });
  }

  // Richest threads first, so a sitting that stops early has labelled the ones
  // worth most; the one-reply threads come last and are quick.
  const order = ['customer_followup', 'other_sender', 'replied_once'];
  selected.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));

  console.log(`\n${tickets.length} tickets lus.`);
  for (const [group, [threads, cuts]] of Object.entries(tally)) {
    const mark = groups.includes(group) ? '✓' : ' ';
    console.log(`  ${mark} ${group.padEnd(18)} ${String(threads).padStart(4)} fils · ${String(cuts).padStart(4)} coupes`);
  }
  const cutCount = selected.reduce((sum, t) => sum + t.cuts.length, 0);
  const inbound = selected.reduce((sum, t) => sum + t.cuts.filter((c) => c.direction === 'inbound').length, 0);
  console.log(`  = ${selected.length} fils, ${cutCount} coupes (${inbound} reçues, ${cutCount - inbound} envoyées)\n`);
  if (countOnly) return;

  const investigations = prefill ? await loadInvestigations(supabase, shopId, selected) : new Map();
  const openai = prefill ? createOpenAIClient({ apiKey: config.openaiApiKey }) : null;
  let calls = 0;
  let failed = 0;

  const threads = [];
  for (const { ticket, conversation, group, cuts } of selected) {
    if (prefill) {
      const counted = await prefillThread({ ticket, conversation, cuts, investigations, openai, model: config.caseworkModel, senderDirectory });
      calls += counted.calls;
      failed += counted.failed;
      process.stdout.write('.');
    }
    threads.push({
      ticketId: ticket.id,
      subject: ticket.subject,
      category: [ticket.category, ticket.request_kind].filter(Boolean).join(' / ') || 'non classé',
      group,
      messages: conversation.map((message) => {
        const { own, quoted } = splitQuotedReply(message.body_text || '');
        return {
          id: message.id,
          direction: message.direction === 'outbound' ? 'outbound' : 'inbound',
          roleName: senderRoleName(message, senderDirectory),
          at: message.received_at ?? message.sent_at ?? null,
          own: own?.trim() || '',
          quoted: quoted?.trim() || ''
        };
      }),
      cuts
    });
  }

  const html = renderReviewPage({
    threads,
    generatedAt: new Date().toISOString(),
    prefillModel: prefill ? config.caseworkModel : null
  });
  writeFileSync(outPath, html, 'utf8');
  if (prefill) console.log(`\nSuggestions : ${calls} appel(s) ${config.caseworkModel}, ${failed} échec(s).`);
  console.log(`Page écrite : ${outPath} — contient du courrier réel, ne pas la committer ni la publier.`);
}

/**
 * The newest investigation per ticket, with the position of its trigger.
 *
 * On the imported corpus most threads were investigated once, at the end, so
 * for most cuts no case file existed yet and the suggestion starts from an
 * empty question list. That is what the pipeline would have known, and it is
 * stated rather than papered over with a case file from the future.
 */
async function loadInvestigations(supabase, shopId, selected) {
  const byTicket = new Map();
  const ids = selected.map((t) => t.ticket.id);
  for (let i = 0; i < ids.length; i += 50) {
    const rows = await supabaseSelect(
      supabase,
      T.TICKET_INVESTIGATIONS,
      { shop_id: shopId, ticket_id: { operator: 'in', value: `(${ids.slice(i, i + 50).join(',')})` } },
      'ticket_id,trigger_message_id,missing'
    );
    for (const row of rows) {
      if (!byTicket.has(row.ticket_id)) byTicket.set(row.ticket_id, []);
      byTicket.get(row.ticket_id).push(row);
    }
  }
  return byTicket;
}

/**
 * Runs the Case Manager on each inbound cut, as it would have run then.
 *
 * The questions carried into a cut are the previous cut's result, seeded from
 * a case file only if one was triggered by an EARLIER message — the same
 * `previous ?? investigation` the runner uses. Outbound cuts are left blank:
 * nothing in the pipeline reads our own mail, so there is nothing to suggest.
 */
async function prefillThread({ ticket, conversation, cuts, investigations, openai, model, senderDirectory }) {
  const position = new Map(conversation.map((message, index) => [message.id, index]));
  const runs = (investigations.get(ticket.id) || [])
    .map((row) => ({ ...row, index: position.get(row.trigger_message_id) ?? Infinity }))
    .sort((a, b) => a.index - b.index);

  let pending = null;
  let calls = 0;
  let failed = 0;
  for (const cut of cuts) {
    if (cut.direction !== 'inbound') continue;
    const earlier = runs.filter((run) => run.index < cut.index).at(-1);
    const carried = pending ?? (earlier?.missing ?? []).map((item) => item?.field).filter(Boolean);
    const thread = threadUpTo(conversation, cut.index);
    const reading = await readCase({
      openai,
      model,
      ticket,
      message: thread.at(-1),
      conversation: thread,
      pendingInputs: carried,
      senderDirectory,
      logger
    });
    calls += 1;
    if (reading.failed) {
      failed += 1;
      cut.prefill = { failed: true };
      continue;
    }
    pending = pendingAfter({ previousPending: carried, resolvedInputs: reading.resolvedInputs });
    cut.prefill = {
      effect: reading.caseRelationship === 'unclear' ? null : reading.caseRelationship,
      answered: reading.resolvedInputs,
      waitingCustomer: pending
    };
  }
  return { calls, failed };
}

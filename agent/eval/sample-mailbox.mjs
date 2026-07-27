// Samples real support mail into categorisation_review so a human can label it.
//
// STRICTLY READ-ONLY ON THE MAILBOX. Every Graph call here is a GET: it lists
// message ids in a date window and fetches those messages. Nothing is sent,
// modified, moved, flagged or deleted, and reading a message over Graph does not
// mark it as read (that would need a PATCH, which this file never issues).
//
// It also does NOT ingest: no tickets, no ticket_messages, no delta cursor. The
// delta endpoint is deliberately avoided so a sampling run cannot disturb the
// ingestion pipeline's position in the mailbox.
//
// The agent_* columns are left empty on purpose — the reviewer labels blind, and
// compare-review-labels.mjs fills them in afterwards.
//
//   npm run review:sample -- --mailbox=contact@qiriness.com
//   npm run review:sample -- --mailbox=... --dry-run    # fetch + print, write nothing
//   npm run review:sample -- --mailbox=... --count=60
//   npm run review:sample -- --mailbox=... --months=2025-11,2025-12,2026-01
//
// --mailbox overrides SUPPORT_MAILBOX for this run only. Sampling a mailbox is
// not the same decision as pointing the ingestion worker at it, so the tool takes
// the address explicitly instead of depending on (or mutating) the worker's config.

import { createSupabaseClient, supabaseUpsert } from '../../scripts/lib/supabase-rest-client.mjs';

import { loadAgentConfig, assertGraphConfig } from '../src/config.mjs';
import { createGraphClient } from '../src/ingestion/graph-client.mjs';
import { mapGraphMessage } from '../src/ingestion/graph-message-mapper.mjs';
import { createBlocklistStore } from '../src/ingestion/blocklist-store.mjs';
import { resolveShopId } from '../src/lib/shop.mjs';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const DEFAULT_MONTHS = ['2025-11', '2025-12', '2026-01'];
const DEFAULT_COUNT = 40;
const LIST_SELECT = 'id,receivedDateTime,subject,from';
const MESSAGE_SELECT = 'id,conversationId,internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,bodyPreview,body,hasAttachments,isDraft';
const MAX_PAGES_PER_MONTH = 10;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseConfig = loadAgentConfig();
  const mailbox = args.mailbox || baseConfig.graph.mailbox;
  const config = { ...baseConfig, graph: { ...baseConfig.graph, mailbox } };
  assertGraphConfig(config);

  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);
  const graph = createGraphClient(config);

  console.log(`\nMailbox   ${mailbox}   (read-only: GET requests only)`);
  console.log(`Months    ${args.months.join(', ')}`);
  console.log(`Sample    ${args.count}${args.dryRun ? '   [dry run — nothing written]' : ''}\n`);

  // 1. List candidate ids per month (cheap projection, no bodies).
  const perMonth = [];
  for (const month of args.months) {
    const { start, end } = monthWindow(month);
    const ids = await listMessageIds(graph, mailbox, start, end);
    perMonth.push({ month, ids });
    console.log(`  ${month}   ${ids.length} messages in the inbox`);
  }

  const available = perMonth.reduce((n, m) => n + m.ids.length, 0);
  if (available === 0) {
    throw new Error('No messages found in those months — check the mailbox and the date range.');
  }

  // 2. Random sample, spread evenly across the months so one busy month cannot
  //    dominate the review set.
  const picked = sampleEvenly(perMonth, Math.min(args.count, available));
  console.log(`\n  sampled ${picked.length} of ${available}\n`);

  // 3. Fetch each sampled message in full (still GET).
  const { gate } = await createBlocklistStore(supabase).loadGate(shopId);
  const batch = new Date().toISOString();
  const rows = [];
  for (const item of picked) {
    const raw = await getMessage(graph, mailbox, item.id);
    const mapped = mapGraphMessage(raw);
    if (mapped.removed) continue;

    const message = mapped.message;
    rows.push({
      shop_id: shopId,
      graph_message_id: message.graph_message_id,
      received_at: message.received_at,
      // Domain only: enough to tell a B2B enquiry from a consumer one.
      from_domain: domainOf(message.from_email),
      subject: message.subject,
      body_text: message.body_text,
      blocklist_would_drop: gate.check(mapped).spam,
      sample_batch: batch
    });
    process.stdout.write('.');
  }
  process.stdout.write('\n');

  const blocked = rows.filter((r) => r.blocklist_would_drop).length;
  console.log(`\n  ${rows.length} fetched · ${blocked} would be dropped by the blocklist before the categoriser`);

  if (args.dryRun) {
    for (const row of rows) {
      console.log(`\n  ${row.received_at}  @${row.from_domain || '?'}${row.blocklist_would_drop ? '  [blocklist]' : ''}`);
      console.log(`  ${row.subject || '(no subject)'}`);
      console.log(`  ${(row.body_text || '').slice(0, 160).replace(/\s+/g, ' ')}...`);
    }
    console.log('\ndry run — nothing written to Supabase.\n');
    return;
  }

  // Idempotent: re-running updates rows instead of duplicating them, so a repeat
  // run cannot silently double the review set (or overwrite a label — the
  // human_* columns are not in the payload, so an upsert leaves them untouched).
  await supabaseUpsert(supabase, 'categorisation_review', rows, 'shop_id,graph_message_id');

  console.log(`\nWritten to categorisation_review (batch ${batch}).`);
  console.log('Label human_category / human_request_kind / human_level in the Supabase table editor,');
  console.log('then run: npm run review:compare\n');
}

/** Pages through one month's inbox, projecting ids only. GET only. */
async function listMessageIds(graph, mailbox, start, end) {
  const filter = `receivedDateTime ge ${start} and receivedDateTime lt ${end}`;
  let url =
    `${GRAPH_BASE}/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages` +
    `?$select=${LIST_SELECT}&$top=100&$orderby=receivedDateTime desc&$filter=${encodeURIComponent(filter)}`;

  const ids = [];
  for (let page = 0; page < MAX_PAGES_PER_MONTH && url; page += 1) {
    const payload = await graphGet(graph, url);
    for (const message of payload.value || []) {
      ids.push({ id: message.id, receivedDateTime: message.receivedDateTime });
    }
    url = payload['@odata.nextLink'] || null;
  }
  return ids;
}

async function getMessage(graph, mailbox, id) {
  const url =
    `${GRAPH_BASE}/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(id)}` +
    `?$select=${MESSAGE_SELECT}`;
  return graphGet(graph, url);
}

async function graphGet(graph, url) {
  const token = await graph.getToken();
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Graph GET failed (${response.status}): ${payload?.error?.message || payload?.error?.code || ''}`);
  }
  return payload;
}

/**
 * Even spread across months, remainder to the earliest months, then a random
 * draw within each. A single busy month would otherwise decide the review set.
 */
function sampleEvenly(perMonth, total) {
  const months = perMonth.filter((m) => m.ids.length > 0);
  const picked = [];
  let remaining = total;

  for (let i = 0; i < months.length; i += 1) {
    const monthsLeft = months.length - i;
    const want = Math.min(Math.ceil(remaining / monthsLeft), months[i].ids.length);
    picked.push(...shuffle([...months[i].ids]).slice(0, want));
    remaining -= want;
  }
  return picked;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function monthWindow(month) {
  const [year, m] = month.split('-').map(Number);
  if (!year || !m || m < 1 || m > 12) {
    throw new Error(`Bad month "${month}" — expected YYYY-MM.`);
  }
  const start = new Date(Date.UTC(year, m - 1, 1)).toISOString();
  const end = new Date(Date.UTC(m === 12 ? year + 1 : year, m % 12, 1)).toISOString();
  return { start, end };
}

function domainOf(email) {
  if (!email || typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase() : null;
}

function parseArgs(argv) {
  const get = (name) => {
    const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  return {
    mailbox: get('mailbox'),
    months: (get('months') || DEFAULT_MONTHS.join(',')).split(',').map((m) => m.trim()),
    count: Number.parseInt(get('count') || String(DEFAULT_COUNT), 10),
    dryRun: argv.includes('--dry-run')
  };
}

main().catch((error) => {
  console.error(`\nsampling failed: ${error.message}\n`);
  process.exitCode = 1;
});

import { createSupabaseClient, supabaseSelectAll } from '../../../scripts/lib/supabase-rest-client.mjs';
import { createTicketRecord } from '../../../scripts/lib/ticket-record.mjs';
import { loadCompany } from '../../../scripts/lib/company.mjs';
import { loadAgentModels, withAgentModels } from '../../../scripts/lib/agent-models.mjs';
import { TICKET_SUBJECTS } from '../../../scripts/lib/support-taxonomy.mjs';

import { loadAgentConfig } from '../config.mjs';
import { logger } from '../lib/logger.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { createOpenAIClient } from '../llm/openai-client.mjs';
import { createShopUsageRecording } from '../llm/usage-store.mjs';
import { createCategoriser } from '../pipeline/categorise.mjs';
import { relabelPatch } from '../pipeline/relabel-subject.mjs';
import { isAutoReply } from '../casework/actors.mjs';

// Backfills a NEW subject onto tickets that were categorised before it existed.
//
//   npm run tickets:relabel-subject:dry-run -- --subject=defective_product
//   npm run tickets:relabel-subject -- --subject=defective_product
//
// Each candidate is re-read by the live categoriser (same prompt, same model as
// the worker, same first + latest inbound message), and only a reading that
// lands on the new subject is written — see relabel-subject.mjs for why nothing
// else is. Open, closed and resolved tickets alike; no flag moves, so nothing
// is re-investigated, re-drafted or re-routed.
//
// CANDIDATES are the tickets whose subject the new one was split from, plus
// any whose latest case file matched one of the new subject's situations:
//   --from=product              subjects to re-read (primary or secondary)
//   --situations=PR-38,PR-26    situation keys whose matches are re-read too
// Defaults are the defective_product split of 2026-11-06.
//
// READ THE DRY RUN: it pays for the model calls (one per candidate) but writes
// nothing, and prints every ticket that would move with the model's reason.

const args = parseArgs(process.argv.slice(2));
const dryRun = Boolean(args['dry-run']);
const target = args.subject || 'defective_product';
const fromSubjects = String(args.from || 'product').split(',').map((s) => s.trim()).filter(Boolean);
const situations = String(args.situations || 'PR-38,PR-26').split(',').map((s) => s.trim()).filter(Boolean);
const BY = 'tickets:relabel-subject';

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  if (!TICKET_SUBJECTS.includes(target)) throw new Error(`--subject=${target} is not a ticket subject.`);
  for (const s of fromSubjects) {
    if (!TICKET_SUBJECTS.includes(s)) throw new Error(`--from=${s} is not a ticket subject.`);
  }

  const config = loadAgentConfig();
  if (!config.openaiApiKey) throw new Error('OPENAI_API_KEY is not set.');
  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);
  const record = createTicketRecord(supabase, { shopId });
  const models = withAgentModels(config, await loadAgentModels(supabase, shopId));
  const company = await loadCompany(supabase, shopId).catch(() => null);
  const usage = createShopUsageRecording({ supabase, shopId, logger });
  const openai = createOpenAIClient({ apiKey: config.openaiApiKey, usageSink: usage.sink });
  const { categorise } = createCategoriser(openai, { model: models.categoriserModel, company });

  const candidates = await loadCandidates(supabase, shopId);
  console.log(
    `\n${dryRun ? 'DRY RUN — nothing will be written.' : 'Writing relabels.'} ` +
      `${candidates.length} candidates (subject ${fromSubjects.join('/')} or situation ${situations.join('/')}) → ${target}\n`
  );

  const totals = { considered: 0, primary: 0, secondary: 0, unchanged: 0, skipped: 0, failed: 0 };
  for (const ticket of candidates) {
    totals.considered += 1;
    const inbound = (await record.inboundMessages(ticket.id)).filter((m) => !isAutoReply(m));
    const messages = inbound.length > 2 ? [inbound[0], inbound[inbound.length - 1]] : inbound;
    if (messages.length === 0) {
      totals.skipped += 1;
      continue;
    }
    let result;
    try {
      result = await categorise({ subject: ticket.subject, messages }, { ticketId: ticket.id });
    } catch (error) {
      totals.failed += 1;
      console.log(`  #${ticket.ticket_number}  FAILED ${error.message}`);
      continue;
    }

    const patch = relabelPatch(ticket, result, { target, by: BY });
    const was = `${ticket.category}/${ticket.request_kind} L${ticket.level}`;
    if (!patch) {
      totals.unchanged += 1;
      console.log(`  #${ticket.ticket_number}  ${ticket.status.padEnd(17)} ${was.padEnd(28)} stays   (read ${result.category}/${result.request_kind})`);
      continue;
    }
    totals[patch.change] += 1;
    const now = patch.change === 'primary'
      ? `${patch.columns.category}/${patch.columns.request_kind} L${patch.columns.level ?? ticket.level}`
      : `secondary ${patch.columns.secondary_category}/${patch.columns.secondary_request_kind}`;
    console.log(`  #${ticket.ticket_number}  ${ticket.status.padEnd(17)} ${was.padEnd(28)} → ${now}  « ${result.reason ?? ''} »`);
    if (!dryRun) await record.relabel(ticket, patch);
  }

  const spend = await usage.flush();
  console.log(
    `\nconsidered ${totals.considered} | primary ${totals.primary} | secondary ${totals.secondary} | ` +
      `unchanged ${totals.unchanged} | no inbound ${totals.skipped} | failed ${totals.failed} | ` +
      `${spend.calls} model calls\n`
  );
}

async function loadCandidates(supabase, shopId) {
  const columns =
    'id,ticket_number,subject,status,category,request_kind,secondary_category,secondary_request_kind,' +
    'level,happiness,responsible_team,metadata,overrides';
  const live = { shop_id: shopId, deleted_at: { operator: 'is', value: 'null' }, status: { operator: 'neq', value: 'spam' } };
  const list = `(${fromSubjects.join(',')})`;
  const [primary, secondary, matched] = await Promise.all([
    supabaseSelectAll(supabase, 'tickets', { ...live, category: { operator: 'in', value: list } }, columns),
    supabaseSelectAll(supabase, 'tickets', { ...live, secondary_category: { operator: 'in', value: list } }, columns),
    situations.length
      ? supabaseSelectAll(supabase, 'ticket_investigations', { shop_id: shopId }, 'ticket_id,exemplar_match')
      : []
  ]);
  const byId = new Map([...primary, ...secondary].map((t) => [t.id, t]));
  const extra = [
    ...new Set(matched.filter((r) => situations.includes(r.exemplar_match?.exemplar_key)).map((r) => r.ticket_id))
  ].filter((id) => !byId.has(id));
  if (extra.length) {
    const rows = await supabaseSelectAll(supabase, 'tickets', { ...live, id: { operator: 'in', value: `(${extra.join(',')})` } }, columns);
    for (const t of rows) byId.set(t.id, t);
  }
  return [...byId.values()]
    .filter((t) => t.category && t.category !== target)
    .sort((a, b) => a.ticket_number - b.ticket_number);
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (match) out[match[1]] = match[2] ?? true;
  }
  return out;
}

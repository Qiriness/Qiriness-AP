import { createSupabaseClient, supabaseSelectAll } from '../../../scripts/lib/supabase-rest-client.mjs';
import { loadAgentConfig } from '../config.mjs';
import { resolveShopId } from '../lib/shop.mjs';
const config = loadAgentConfig();
const sb = createSupabaseClient(config);
const shopId = await resolveShopId(sb, config.shopDomain);
const live = { shop_id: shopId, deleted_at: { operator: 'is', value: 'null' } };
const cutover = (await supabaseSelectAll(sb, 'shops', { id: shopId }, 'sync_cursors'))[0].sync_cursors.mail_ingest_cutover_at;
const cat = await supabaseSelectAll(sb, 'tickets', { ...live, needs_categorisation: { operator: 'is', value: 'true' } }, 'id');
const inv = await supabaseSelectAll(sb, 'tickets', { ...live, needs_investigation: { operator: 'is', value: 'true' } }, 'id');
const others = await supabaseSelectAll(sb, 'ticket_messages', { ...live, actor: { operator: 'in', value: '(support,colleague,partner)' }, received_at: { operator: 'gt', value: cutover } }, 'id');
const states = await supabaseSelectAll(sb, 'ticket_case_state', { shop_id: shopId }, 'trigger_message_id,read_at', { order: 'read_at.desc' });
const read = new Set(states.map((s) => s.trigger_message_id));
const since = process.argv[2] ?? '2026-10-03T08:46:30Z';
const usage = await supabaseSelectAll(sb, 'llm_usage', { shop_id: shopId, occurred_at: { operator: 'gt', value: since } }, 'pass,model,call_count,total_tokens,succeeded');
const byPass = {}; for (const u of usage) { const k = `${u.pass}|${u.model}${u.succeeded === false ? '|FAILED' : ''}`; byPass[k] = (byPass[k] || 0) + (u.call_count ?? 1); }
console.log(JSON.stringify({
  at: new Date().toISOString(),
  needs_categorisation: cat.length,
  needs_investigation: inv.length,
  casework_unread_since_cutover: others.filter((m) => !read.has(m.id)).length,
  latest_case_reading: states[0]?.read_at ?? null,
  model_calls_since: { since, byPass }
}, null, 2));

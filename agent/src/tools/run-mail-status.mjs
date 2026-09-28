import { createSupabaseClient, supabaseSelect } from '../../../scripts/lib/supabase-rest-client.mjs';
import { createMailJobRecord } from '../../../scripts/lib/mail-job-record.mjs';
import { createMailSubscriptionRecord } from '../../../scripts/lib/mail-subscription-record.mjs';
import { T } from '../../../scripts/lib/tables.mjs';

import { loadAgentConfig } from '../config.mjs';
import { resolveShopId } from '../lib/shop.mjs';

// Where the mail layer stands, read only:
//
//   npm run mail:status
//
// The switches as this worker reads them, the job queue (dead jobs listed with
// their last error), outbound actions by state (the unfinished ones listed),
// and each change-notification subscription with its expiry and last error.
// No Graph call, no write, no message body and no address.

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);

  console.log('\nSwitches');
  console.log(`  OUTBOUND_SEND_ENABLED  ${config.outboundSendEnabled}`);
  console.log(`  OUTBOUND_STOP_BEFORE_SEND ${config.outboundStopBeforeSend}  (true: replies stop in the mailbox's Drafts)`);
  console.log(`  DRAFT_ONLY             ${config.draftOnly}  (auto-send needs false)`);
  console.log(`  MAIL_WEBHOOK_URL       ${config.mailWebhookUrl ? 'set' : 'unset (no subscriptions; the timed poll does everything)'}`);

  const jobs = createMailJobRecord(supabase, { shopId });
  console.log('\nMail jobs');
  for (const state of ['queued', 'running', 'dead']) {
    const rows = await jobs.list({ state, limit: 50 });
    console.log(`  ${state.padEnd(8)} ${rows.length}${rows.length === 50 ? '+' : ''}`);
    if (state === 'dead') {
      for (const row of rows.slice(0, 10)) {
        console.log(`    ${row.kind} ${row.dedupe_key} after ${row.retry_count} attempts: ${row.last_error ?? ''}`);
      }
    }
  }

  const actions = await supabaseSelect(
    supabase,
    T.OUTBOUND_ACTIONS,
    { shop_id: shopId },
    'id,ticket_id,mode,state,cancel_reason,failure_reason,created_at',
    { order: 'created_at.desc', limit: 200 }
  );
  const byState = new Map();
  for (const action of actions) byState.set(action.state, (byState.get(action.state) ?? 0) + 1);
  console.log('\nOutbound actions (latest 200)');
  for (const [state, count] of byState) console.log(`  ${state.padEnd(15)} ${count}`);
  for (const action of actions.filter((a) => ['approved', 'draft_created', 'send_requested', 'failed'].includes(a.state)).slice(0, 15)) {
    console.log(`    ${action.state} ticket ${action.ticket_id} (${action.mode}) ${action.failure_reason ?? ''}`);
  }

  const subscriptions = await createMailSubscriptionRecord(supabase).forShop(shopId);
  console.log('\nSubscriptions');
  if (subscriptions.length === 0) console.log('  none');
  for (const row of subscriptions) {
    console.log(
      `  ${row.folder.padEnd(9)} expires ${row.expires_at}${row.needs_renewal ? ' (renewal requested)' : ''}` +
        (row.last_error ? `  last error ${row.last_error_at}: ${row.last_error}` : '')
    );
  }
  console.log('');
}

import { loadEnv } from './scripts/lib/sync-config.mjs';
import { createSupabaseClient, supabaseSelect } from './scripts/lib/supabase-rest-client.mjs';
import { T } from './scripts/lib/tables.mjs';

const env = loadEnv();
const supabase = createSupabaseClient({
  supabaseUrl: env.SUPABASE_URL,
  supabaseKey: env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY
});
const rows = await supabaseSelect(supabase, T.AGENT_TEST_RUNS, {}, '*', { order: 'ran_at.desc', limit: 5 });
for (const r of rows) {
  console.log('=========================================');
  console.log('id', r.id, '|', r.ran_at, '|', r.status);
  console.log('requester', r.requester_name, r.requester_email_masked, '| order field:', r.order_number);
  console.log('body:', JSON.stringify(r.body_text));
  console.log('labels:', r.category, r.request_kind, 'L' + r.level, '| verdict:', r.verdict);
  console.log('draft skipped:', r.draft_skipped_reason);
}

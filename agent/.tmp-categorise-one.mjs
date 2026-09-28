// One-off: categorise a single named ticket (runCategorisation narrowed by ticketId).
import { createSupabaseClient } from '../scripts/lib/supabase-rest-client.mjs';
import { createTicketRecord } from '../scripts/lib/ticket-record.mjs';
import { loadAgentConfig } from './src/config.mjs';
import { logger } from './src/lib/logger.mjs';
import { resolveShopId } from './src/lib/shop.mjs';
import { createOpenAIClient } from './src/llm/openai-client.mjs';
import { createShopUsageRecording } from './src/llm/usage-store.mjs';
import { createCategoriser } from './src/pipeline/categorise.mjs';
import { runCategorisation } from './src/pipeline/categorise-runner.mjs';

const ticketId = process.argv[2];
if (!ticketId) throw new Error('usage: node .tmp-categorise-one.mjs <ticket id>');

const config = loadAgentConfig();
const supabase = createSupabaseClient(config);
const shopId = await resolveShopId(supabase, config.shopDomain);
const usage = createShopUsageRecording({ supabase, shopId, logger });
const openai = createOpenAIClient({ apiKey: config.openaiApiKey, usageSink: usage.sink });
const { categorise } = createCategoriser(openai, { model: config.categoriserModel });

const totals = await runCategorisation({
  record: createTicketRecord(supabase, { shopId }),
  categorise,
  logger,
  limit: 1,
  ticketId
});
console.log(JSON.stringify(totals));
if (usage.sink.size > 0) console.log('usage', JSON.stringify(await usage.flush()));

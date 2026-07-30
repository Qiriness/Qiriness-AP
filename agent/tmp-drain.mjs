import { createSupabaseClient } from '../scripts/lib/supabase-rest-client.mjs';
import { loadAgentConfig } from './src/config.mjs';
import { resolveShopId } from './src/lib/shop.mjs';
import { createOpenAIClient } from './src/llm/openai-client.mjs';
import { createCategoriser } from './src/pipeline/categorise.mjs';
import { runCategorisation, createSupabaseCategoriserStore } from './src/pipeline/categorise-runner.mjs';
const config = loadAgentConfig();
const supabase = createSupabaseClient(config);
const shopId = await resolveShopId(supabase, config.shopDomain);
const { categorise } = createCategoriser(createOpenAIClient({ apiKey: config.openaiApiKey }), { model: config.categoriserModel });
const store = createSupabaseCategoriserStore(supabase);
const totals = { categorised: 0, recategorised: 0, skipped: 0, failed: 0, fallbacks: 0 };
for (let p = 1; p <= 40; p += 1) {
  const c = await runCategorisation({ store, categorise, shopId, limit: 25 });
  for (const k of Object.keys(totals)) totals[k] += c[k];
  if (c.categorised + c.recategorised + c.skipped + c.failed === 0) break;
}
console.log('totals:', JSON.stringify(totals));

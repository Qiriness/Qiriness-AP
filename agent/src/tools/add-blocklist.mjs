import { createSupabaseClient } from '../../../scripts/lib/supabase-rest-client.mjs';

import { loadAgentConfig } from '../config.mjs';
import { logger } from '../lib/logger.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { createBlocklistStore } from '../ingestion/blocklist-store.mjs';

// Add a sender to the spam blocklist and purge any already-stored mail from them.
//
//   npm run blocklist:add -- spammer@bad.com        # blocks the exact address
//   npm run blocklist:add -- junk.example           # blocks the whole domain
//   npm run blocklist:add -- foo@bar.com --domain   # force domain interpretation
//   npm run blocklist:add -- junk.example --reason "bulk marketing"

const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const value = positional[0];
const forceDomain = process.argv.includes('--domain');
const reasonIndex = process.argv.indexOf('--reason');
const reason = reasonIndex >= 0 ? process.argv[reasonIndex + 1] || null : null;

if (!value) {
  console.error('Usage: npm run blocklist:add -- <email|domain> [--domain] [--reason "..."]');
  process.exitCode = 1;
} else {
  main(value).catch((error) => {
    logger.error('blocklist.add_failed', { message: error.message });
    process.exitCode = 1;
  });
}

async function main(pattern) {
  const config = loadAgentConfig();
  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);
  const store = createBlocklistStore(supabase);

  // An address contains '@'; anything else is treated as a domain.
  const patternType = !forceDomain && pattern.includes('@') ? 'email' : 'domain';
  const { rule, purgedTickets } = await store.addRule(shopId, {
    patternType,
    pattern,
    reason,
    createdBy: 'manual'
  });

  logger.info('blocklist.added', {
    patternType,
    pattern: rule.pattern,
    purgedTickets
  });
}

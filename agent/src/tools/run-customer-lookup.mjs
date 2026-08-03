import { createSupabaseClient } from '../../../scripts/lib/supabase-rest-client.mjs';

import { loadAgentConfig } from '../config.mjs';
import { logger } from '../lib/logger.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { createCustomerLookup } from '../retrieval/customer-lookup.mjs';

// Runs the customer/CRM lookup on its own, against one address.
//
//   npm run customer:lookup -- marie.martin@example.test
//   npm run customer:lookup -- marie.martin@example.test --json
//   npm run customer:lookup -- marie.martin@example.test --with-email
//
// The point of the tool is that it needs no order number and no ticket, so the
// CLI needs nothing but an address. `--json` prints the structured bundle a
// caller would receive; the default prints the prompt text a drafting step would
// read, which is the thing worth eyeballing.
//
// Reading a real customer here writes a `data_access_events` row, exactly as it
// would in the worker. That is the intent — a lookup run by hand is still access
// to personal data and belongs in the audit trail.

const args = process.argv.slice(2);
const email = args.find((arg) => !arg.startsWith('--'));
const asJson = args.includes('--json');
const includeEmail = args.includes('--with-email');

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  if (!email) {
    console.error('Usage: npm run customer:lookup -- <email> [--json] [--with-email]');
    process.exitCode = 1;
    return;
  }

  const config = loadAgentConfig();
  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);
  const lookup = createCustomerLookup({ supabase, shopId, logger });

  const result = await lookup.lookupCustomer({ email, includeEmail });

  if (asJson) {
    console.log(JSON.stringify(result, null, 1));
    return;
  }

  console.log(`\n${result.promptText}\n`);
  if (result.found) {
    console.log(`(matched by ${result.matchedBy}, RFM ${result.customer.rfmGroup || 'n/a'})`);
  }
}

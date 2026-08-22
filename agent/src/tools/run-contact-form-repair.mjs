import { createSupabaseClient } from '../../../scripts/lib/supabase-rest-client.mjs';

import { loadAgentConfig, assertGraphConfig } from '../config.mjs';
import { logger } from '../lib/logger.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { createGraphClient } from '../ingestion/graph-client.mjs';
import {
  createContactFormRepairStore,
  runContactFormRepair
} from '../ingestion/contact-form-repair.mjs';

// Repairs outbound messages that a contact-form parse mis-filed under the
// customer's name, discarding the reply we actually sent.
//
//   npm run repair:contact-form:dry-run              # show, write nothing
//   npm run repair:contact-form -- --identity-only   # sender only, no network
//   npm run repair:contact-form -- --limit=100       # sender + body, from Graph
//
// READ THE DRY RUN FIRST. It prints the stored body beside the one Graph
// returns, which is the only place you can see that the recovered text is our
// reply rather than another copy of the customer's message.
//
// --identity-only needs no Graph credentials: the true sender was recorded at
// ingestion under raw_graph_payload.contactForm.envelopeFrom. The body can only
// come from the mailbox.

const dryRun = process.argv.includes('--dry-run');
const identityOnly = process.argv.includes('--identity-only');
const limit = parseLimit(process.argv) ?? 25;

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  if (!identityOnly) {
    assertGraphConfig(config);
  }

  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);

  console.log(
    `\n${dryRun ? 'DRY RUN — nothing will be written.' : 'Writing repairs for real.'}\n` +
      `mode: ${identityOnly ? 'identity only (no Graph calls)' : 'identity + body from Graph'}\n` +
      `rows: up to ${limit}, newest first\n`
  );

  const totals = await runContactFormRepair({
    store: createContactFormRepairStore(supabase),
    graphClient: identityOnly ? null : createGraphClient(config),
    mailbox: config.graph.mailbox,
    shopId,
    limit,
    dryRun,
    identityOnly,
    logger,
    onPreview: ({ row, outcome, patch, recovered, error }) => {
      const subject = clip(row.subject || '(no subject)', 54);
      console.log(`  ${String(outcome).padEnd(30)} "${subject}"`);
      if (error) {
        console.log(`      ${error.message}`);
        return;
      }
      if (patch?.from_email && patch.from_email !== row.from_email) {
        console.log(`      sender  ${row.from_email}  ->  ${patch.from_email}`);
      }
      if (recovered != null) {
        console.log(`      stored  "${clip(row.body_text, 70)}"`);
        console.log(`      actual  "${clip(recovered, 70)}"`);
      }
    }
  });

  console.log(
    `\nconsidered ${totals.considered} | repaired ${totals.identityFixed} | ` +
      `bodies recovered ${totals.bodyRecovered} | gone from mailbox ${totals.missing} | ` +
      `failed ${totals.failed}\n`
  );
}

function clip(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function parseLimit(argv) {
  const flag = argv.find((arg) => arg.startsWith('--limit='));
  if (!flag) {
    return null;
  }
  const value = Number(flag.split('=')[1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

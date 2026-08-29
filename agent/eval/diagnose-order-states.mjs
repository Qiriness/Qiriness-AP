import { createSupabaseClient, supabaseSelectAll } from '../../scripts/lib/supabase-rest-client.mjs';
import { T } from '../../scripts/lib/tables.mjs';

import { loadAgentConfig } from '../src/config.mjs';
import { resolveShopId } from '../src/lib/shop.mjs';
import { STALE_TRANSIT_DAYS } from '../src/investigation/investigation-rules.mjs';
import { orderStates } from '../src/resolution/order-context.mjs';

// Which order states real tickets actually resolve to.
//
// WHY THIS IS A MEASUREMENT AND NOT A TEST. A unit test proves `not_dispatched`
// is derived correctly from an unfulfilled order; only the corpus can say
// whether any ticket is ever in that state. **A state nothing resolves to is a
// state written wrong** — or one whose data does not exist yet, and those two
// want opposite responses: rewrite the vocabulary, or build the integration.
//
// IT READS `tickets.resolved_context`, NOT STORED CASE FILES, and that is
// forced rather than chosen. `buildCaseFile` stores the tool ledger as
// `{id, tool, argsHash, outcome}` and drops each call's `data`, so findings
// cannot be re-derived from investigation history. The bundle on the ticket is
// the same object `getOrderContext` reads, so deriving from it is a faithful
// preview of what a rule would see.
//
// NO API CALLS AND NO WRITES: one select, pure functions over the rows.
//
//   npm run eval:order-states

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);

  const rows = await supabaseSelectAll(
    supabase,
    T.TICKETS,
    {
      shop_id: shopId,
      resolved_context: { operator: 'not.is', value: 'null' },
      deleted_at: { operator: 'is', value: 'null' }
    },
    'id,category,shopify_order_number,resolved_context'
  );

  const axes = { order_state: {}, delivery_state: {}, payment_state: {} };
  const ages = [];
  let built = 0;

  for (const row of rows) {
    const states = orderStates(row.resolved_context, { staleTransitDays: STALE_TRANSIT_DAYS });
    if (!states) continue;
    built += 1;
    for (const axis of Object.keys(axes)) {
      axes[axis][states[axis]] = (axes[axis][states[axis]] ?? 0) + 1;
    }
    const age = row.resolved_context?.order?.ageDays;
    if (Number.isFinite(age)) ages.push(age);
  }

  console.log(`Order bundles built: ${built} (of ${rows.length} tickets carrying a resolved_context)\n`);

  for (const [axis, counts] of Object.entries(axes)) {
    console.log(axis);
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    for (const [value, n] of entries) {
      console.log(`  ${String(n).padStart(4)}  ${value}`);
    }
    console.log();
  }

  // THE AGE DISTRIBUTION IS WHY A RARE STATE IS NOT A DEAD ONE. A cancellation
  // arrives hours after the order; this corpus holds tickets whose orders were
  // months old by the time a bundle was built, so `not_dispatched` being rare
  // here says more about the corpus than about the state.
  ages.sort((a, b) => a - b);
  if (ages.length > 0) {
    const q = (p) => ages[Math.floor((ages.length - 1) * p)];
    console.log('Order age in days when the bundle was built');
    console.log(
      `  min ${ages[0]}  p25 ${q(0.25)}  median ${q(0.5)}  p75 ${q(0.75)}  max ${ages[ages.length - 1]}`
    );
    console.log(`  placed within 7 days of the bundle: ${ages.filter((a) => a <= 7).length}`);
  }
}

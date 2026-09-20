import { createSupabaseClient, supabaseSelectAll } from '../../scripts/lib/supabase-rest-client.mjs';
import { T, V } from '../../scripts/lib/tables.mjs';

import { days, toParameterMap } from '../../scripts/lib/parameters.mjs';

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

  // THE MERCHANT'S NUMBERS, READ THE SAME WAY THE TOOL READS THEM. Two of the
  // axes below are computed from parameters rather than from the order, so
  // leaving them out would report `unknown` everywhere and look like a broken
  // state instead of an unset setting.
  const parameters = toParameterMap(
    await supabaseSelectAll(supabase, T.SUPPORT_PARAMETERS, { shop_id: shopId }, 'parameter_key,value')
  );
  const windows = {
    staleTransitDays: STALE_TRANSIT_DAYS,
    dispatchDays: days(parameters, 'dispatch_days'),
    franceDeliveryDays: days(parameters, 'france_delivery_days'),
    abroadDeliveryDays: days(parameters, 'abroad_delivery_days')
  };

  // WHEN THE CUSTOMER LAST WROTE, per ticket, because that is the clock the
  // investigation now hands `orderStates`. Measuring against `new Date()` here
  // would put every ticket in a months-old corpus past every window and report
  // an `overdue` count that says nothing about the rule.
  const latestInbound = new Map(
    (
      await supabaseSelectAll(
        supabase,
        V.TICKET_MESSAGE_COUNTS,
        { shop_id: shopId },
        'ticket_id,latest_inbound_at',
        // The paging default is `id.asc`, and a grouped view has no `id`.
        { order: 'ticket_id.asc' }
      )
    ).map((row) => [row.ticket_id, row.latest_inbound_at])
  );
  const clockFor = (ticketId) => {
    const wrote = latestInbound.get(ticketId) || null;
    return wrote ? new Date(wrote) : new Date();
  };

  const axes = {
    order_state: {},
    delivery_state: {},
    delivery_delay_state: {},
    dispatch_state: {},
    payment_state: {}
  };
  const ages = [];
  // The split that says how much traffic the new rule takes off the old one.
  const lateSplit = { overdue: 0, within_window: 0, unknown: 0 };
  let built = 0;
  let withoutClock = 0;

  for (const row of rows) {
    if (!latestInbound.get(row.id)) withoutClock += 1;
    const states = orderStates(row.resolved_context, { ...windows, now: clockFor(row.id) });
    if (!states) continue;
    if (states.delivery_state === 'dispatched_no_scan') {
      lateSplit[states.delivery_delay_state] += 1;
    }
    built += 1;
    for (const axis of Object.keys(axes)) {
      axes[axis][states[axis]] = (axes[axis][states[axis]] ?? 0) + 1;
    }
    const age = row.resolved_context?.order?.ageDays;
    if (Number.isFinite(age)) ages.push(age);
  }

  console.log(`Order bundles built: ${built} (of ${rows.length} tickets carrying a resolved_context)`);
  console.log(
    `Clock: the ticket's latest inbound message` +
      (withoutClock > 0 ? ` (${withoutClock} carried none and fell back to now)` : '') +
      '\n'
  );

  // WHICH RULE THE LARGEST CLUSTER GOES TO. `expediee_sans_scan` answers every
  // dispatched parcel with no scan today; `dispatched_no_scan_delivery_late`
  // takes the `overdue` slice of it. Printed as a split rather than as one more
  // axis, because the question this eval is run to answer is how much of that
  // rule's traffic moves — and a state nothing resolves to is a state written
  // wrong, which is what the other counts here exist to catch.
  const noScan = lateSplit.overdue + lateSplit.within_window + lateSplit.unknown;
  console.log(`dispatched_no_scan tickets: ${noScan}`);
  console.log(`  ${String(lateSplit.overdue).padStart(4)}  overdue        -> dispatched_no_scan_delivery_late`);
  console.log(`  ${String(lateSplit.within_window).padStart(4)}  within_window  -> expediee_sans_scan`);
  console.log(`  ${String(lateSplit.unknown).padStart(4)}  unknown        -> expediee_sans_scan\n`);

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

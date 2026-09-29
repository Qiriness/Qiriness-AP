import { createSupabaseClient, supabaseSelectAll } from '../../../scripts/lib/supabase-rest-client.mjs';
import { T } from '../../../scripts/lib/tables.mjs';
import { isActive } from '../../../scripts/lib/forwarding-destinations.mjs';

import { loadAgentConfig } from '../config.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { createOpenAIClient } from '../llm/openai-client.mjs';
import { createSenderDirectoryStore } from '../ingestion/sender-directory.mjs';
import { createDestinationChooser, planRoute } from '../routing/destination-router.mjs';

// Where would each ticket go? Runs the router over the tickets already in the
// database and prints the decision beside the subject, so the business can
// check it before anything is forwarded.
//
// READ-ONLY. It sends nothing, records nothing and changes no ticket. The only
// side effect is one cheap model call per ticket whose category has a choice.
//
//   npm run route:preview                     # every category with a destination
//   npm run route:preview -- --category=b2b   # one category
//   npm run route:preview -- --open           # open tickets only

const categoryArg = process.argv.find((arg) => arg.startsWith('--category='))?.split('=')[1] ?? null;
const openOnly = process.argv.includes('--open');

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);

  const destinations = await supabaseSelectAll(supabase, T.FORWARDING_DESTINATIONS, { shop_id: shopId }, '*', {
    order: 'position.asc'
  });
  const routed = [...new Set(destinations.filter(isActive).flatMap((d) => d.categories))];
  const categories = categoryArg ? [categoryArg] : routed;
  if (categories.length === 0) {
    console.log('No destination has an address, so nothing would be routed.');
    return;
  }

  const tickets = await supabaseSelectAll(
    supabase,
    T.TICKETS,
    {
      shop_id: shopId,
      category: { operator: 'in', value: `(${categories.join(',')})` },
      deleted_at: { operator: 'is', value: 'null' },
      ...(openOnly ? { status: { operator: 'not.in', value: '(closed,resolved,spam)' } } : {})
    },
    'id,subject,category,request_kind,language,status'
  );
  const directory = await createSenderDirectoryStore(supabase).load(shopId, { supportMailbox: config.graph?.mailbox });
  const { choose } = createDestinationChooser(createOpenAIClient({ apiKey: config.openaiApiKey }), {
    model: config.routerModel
  });

  console.log(`\nRouting preview — nothing is sent. ${tickets.length} ticket(s) in ${categories.join(', ')}.\n`);
  const tally = new Map();

  for (const ticket of tickets.sort((a, b) => a.category.localeCompare(b.category) || a.subject.localeCompare(b.subject))) {
    const plan = planRoute({ ticket, destinations });
    let outcome = 'stays';
    let reason = '';
    if (plan.route === 'fixed') {
      outcome = plan.candidates[0].label;
    } else if (plan.route === 'choose') {
      const messages = await supabaseSelectAll(
        supabase,
        T.TICKET_MESSAGES,
        { ticket_id: ticket.id, direction: 'inbound', deleted_at: { operator: 'is', value: 'null' } },
        'subject,body_text,from_email,received_at',
        { order: 'received_at.asc' }
      );
      const fromEmail = messages[0]?.from_email ?? '';
      const choice = await choose(
        {
          subject: ticket.subject,
          messages,
          senderDomain: fromEmail.split('@')[1] ?? null,
          senderLabel: directory.lookup(fromEmail)?.label ?? null,
          language: ticket.language
        },
        plan.candidates,
        { ticketId: ticket.id }
      );
      outcome = choice.destination?.label ?? 'stays (agent kept it)';
      reason = choice.reason;
    }
    tally.set(outcome, (tally.get(outcome) ?? 0) + 1);
    console.log(
      `[${ticket.category}/${ticket.request_kind}] ${oneLine(ticket.subject, 60)}\n` +
        `    -> ${outcome}${reason ? `  — ${reason}` : ''}`
    );
  }

  console.log('\nTotals:');
  for (const [outcome, count] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(3)}  ${outcome}`);
  }
}

function oneLine(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

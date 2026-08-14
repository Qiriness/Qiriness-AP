import {
  createSupabaseClient,
  supabaseSelectAll
} from '../../scripts/lib/supabase-rest-client.mjs';

import { loadAgentConfig } from '../src/config.mjs';
import { resolveShopId } from '../src/lib/shop.mjs';

// Which questions does the library keep failing?
//
// Every investigation records, per need, whether the knowledge search answered.
// One ticket showing "no approved article covers this" is a nudge; the same gap
// across twenty is a work queue, ordered by how often the desk actually gets
// asked. This is that queue.
//
// TWO GAPS, AND THEY WANT DIFFERENT WORK, which is why `closest` is reported
// rather than a single "unanswered" count:
//
//   WEAK  an article exists and matched badly — retitle it, or widen it. The
//         score says how close: 0.51 against a 0.55 floor is a near miss.
//   NONE  the library holds nothing on the subject. Write it.
//
// IT IS A DEMAND REPORT, NOT A QUALITY ONE. It says nothing about whether the
// answer would have been good — only that the agent had nothing approved to
// answer from, and how often that happened. Pair it with `cluster:tickets`,
// which measures the same demand from the customer's side.
//
//   npm run eval:knowledge-gaps

const KNOWLEDGE_NEEDS = new Set(['product_property', 'policy_answer', 'brand_answer']);

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
    'ticket_investigations',
    { shop_id: shopId },
    'ticket_id,verdict,evidence_gaps,investigated_at'
  );

  const tickets = await supabaseSelectAll(
    supabase,
    'tickets',
    { shop_id: shopId },
    'id,subject,category,request_kind'
  );
  const byId = new Map(tickets.map((t) => [t.id, t]));

  console.log(`${rows.length} investigation(s)\n`);

  // subject -> { none, weak, closest[], examples[] }
  const bySubject = new Map();
  let answered = 0;
  let unanswered = 0;

  for (const row of rows) {
    const ticket = byId.get(row.ticket_id);
    for (const gap of row.evidence_gaps || []) {
      if (!KNOWLEDGE_NEEDS.has(gap.need)) continue;

      if (gap.finding === 'answered') {
        answered += 1;
        continue;
      }
      if (!gap.details || gap.details.libraryAnswered !== false) continue;

      unanswered += 1;
      const key = ticket?.category || 'uncategorised';
      if (!bySubject.has(key)) {
        bySubject.set(key, { none: 0, weak: 0, closest: [], examples: [] });
      }
      const entry = bySubject.get(key);
      if (typeof gap.details.closest === 'number') {
        entry.weak += 1;
        entry.closest.push(gap.details.closest);
      } else {
        entry.none += 1;
      }
      if (entry.examples.length < 3 && ticket?.subject) {
        entry.examples.push(ticket.subject);
      }
    }
  }

  console.log('='.repeat(74));
  console.log('DID THE LIBRARY ANSWER?\n');
  const total = answered + unanswered;
  if (total === 0) {
    console.log('  No investigation has asked it anything yet.');
    console.log('  Run `npm run investigate` over a batch first.\n');
    return;
  }
  console.log(`  answered      ${String(answered).padStart(4)}  (${pct(answered / total)})`);
  console.log(`  could not     ${String(unanswered).padStart(4)}  (${pct(unanswered / total)})\n`);

  console.log('='.repeat(74));
  console.log('WHAT TO WRITE, MOST-ASKED FIRST\n');
  console.log('  subject              missing  near-miss   closest   asked about');

  const ranked = [...bySubject.entries()].sort(
    (a, b) => b[1].none + b[1].weak - (a[1].none + a[1].weak)
  );
  for (const [subject, entry] of ranked) {
    const closest = entry.closest.length
      ? Math.max(...entry.closest).toFixed(2)
      : '—';
    console.log(
      `  ${subject.padEnd(20)} ${String(entry.none).padStart(7)} ${String(entry.weak).padStart(10)} ` +
        `${String(closest).padStart(9)}   ${entry.examples[0] ? excerpt(entry.examples[0]) : ''}`
    );
    for (const example of entry.examples.slice(1)) {
      console.log(`  ${' '.repeat(49)}${excerpt(example)}`);
    }
  }

  console.log('\n  missing   = the library holds nothing on the subject — write it.');
  console.log('  near-miss = an article exists and did not match; `closest` is how near.');
  console.log('              A near-miss above ~0.50 is usually a retitle, not a rewrite.\n');
}

function pct(value) {
  return `${Math.round(value * 100)}%`;
}

function excerpt(value) {
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > 44 ? `${text.slice(0, 44)}…` : text;
}

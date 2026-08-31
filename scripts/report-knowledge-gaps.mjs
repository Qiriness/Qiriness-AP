import { loadConfig, loadEnv } from './lib/sync-config.mjs';
import { createSupabaseClient, supabaseSelectAll } from './lib/supabase-rest-client.mjs';
import { KNOWLEDGE_NEEDS, needLabel } from '../agent/src/investigation/evidence-rules.mjs';

// What customers asked that the library could not answer.
//
//   npm run report:knowledge-gaps
//   npm run report:knowledge-gaps -- --subject product
//   npm run report:knowledge-gaps -- --limit 5
//
// THE COMMISSIONING LIST FOR NEW ARTICLES, and the cheapest useful thing that
// can be built here. Retrieval already runs dense and lexical together and fuses
// them; when it comes back empty over a 61-chunk library the answer is almost
// never "search harder", it is "nobody has written this down". This says which
// ones, in the customers' own words.
//
// ZERO COST PER TICKET. It writes nothing and runs nothing at ingest time: every
// number comes from `ticket_investigations.evidence_gaps`, which the
// investigation already stores, joined to the ticket the question arrived on. An
// agentic retrieval loop would answer the same question by spending a model call
// per ticket, forever, to discover the same absences.
//
// SUBJECT-AGNOSTIC. `KNOWLEDGE_NEEDS` is derived from which needs name
// `searchKnowledge` in `satisfiedBy`, so this reports on any answer set — the
// promotions family gets the same treatment as products with no change here.

const onlySubject = valueOf('--subject');
const perSubject = Number(valueOf('--limit') || 6);

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadConfig(loadEnv());
  const supabase = createSupabaseClient(config);

  const investigations = await supabaseSelectAll(
    supabase,
    'ticket_investigations',
    {},
    'ticket_id,evidence_gaps,knowledge,investigated_at'
  );
  const tickets = await supabaseSelectAll(supabase, 'tickets', {}, 'id,category,subject,level');
  const byId = new Map(tickets.map((t) => [t.id, t]));

  // The question as the customer put it. Read once for the tickets that turn out
  // to have a gap, not for all of them — the bodies are the largest thing this
  // database holds.
  const gaps = [];
  for (const run of investigations) {
    const ticket = byId.get(run.ticket_id);
    if (!ticket) continue;
    if (onlySubject && ticket.category !== onlySubject) continue;

    // WHAT COUNTS AS A GAP: a need an article could have answered, which nothing
    // answered. `weak` counts — a chunk below the band is one the model was never
    // shown, so as far as the reply is concerned it was absent.
    //
    // `state !== 'satisfied'` IS THE HALF THAT MATTERS, and leaving it out is how
    // the first version of this report over-counted product by roughly double.
    // Several of these needs are satisfiable by more than one tool — the product
    // sheet settles `product_property` as well as the library does — so a run can
    // legitimately end `satisfied` with a finding that says the LIBRARY was
    // silent. That is a fact about retrieval, not an article somebody should
    // write, and commissioning one would be answering a question already answered.
    const unanswered = (run.evidence_gaps || []).filter(
      (gap) =>
        KNOWLEDGE_NEEDS.includes(gap.need) &&
        gap.state !== 'satisfied' &&
        (gap.finding === 'none' || gap.finding === 'weak')
    );
    if (unanswered.length === 0) continue;

    gaps.push({
      ticketId: run.ticket_id,
      subject: ticket.category || '(uncategorised)',
      title: ticket.subject || '(no subject)',
      level: ticket.level,
      needs: unanswered.map((g) => g.need),
      // A run that kept chunks answered SOMETHING, just not this need — worth
      // separating, because it is a narrower gap than a search that found nothing.
      keptChunks: Array.isArray(run.knowledge) ? run.knowledge.length : 0
    });
  }

  if (gaps.length === 0) {
    console.log('\nNo unanswered knowledge needs recorded. Either the library covers what is being asked, or nothing has been investigated yet.\n');
    return;
  }

  const bySubject = new Map();
  for (const gap of gaps) {
    if (!bySubject.has(gap.subject)) bySubject.set(gap.subject, []);
    bySubject.get(gap.subject).push(gap);
  }

  const totals = await investigatedPerSubject(supabase, byId);

  console.log('\nWHAT THE LIBRARY COULD NOT ANSWER');
  console.log('Ordered by how often it happened. Each line is an article somebody could write.\n');

  const ordered = [...bySubject.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [subject, list] of ordered) {
    const seen = totals.get(subject) ?? list.length;
    const share = seen > 0 ? Math.round((list.length / seen) * 100) : 0;
    console.log(`\n${subject.toUpperCase()}  —  ${list.length} of ${seen} investigations (${share}%)`);

    // Which need, so the shape of the missing article is obvious: a
    // `product_property` gap wants a spec sheet, a `policy_answer` gap wants a
    // policy page.
    const needCounts = new Map();
    for (const gap of list) {
      for (const need of gap.needs) needCounts.set(need, (needCounts.get(need) ?? 0) + 1);
    }
    for (const [need, count] of [...needCounts].sort((a, b) => b[1] - a[1])) {
      console.log(`   ${String(count).padStart(3)} × ${need} — ${needLabel(need) ?? ''}`);
    }

    console.log('\n   what they asked:');
    for (const gap of list.slice(0, perSubject)) {
      const question = await firstQuestion(supabase, gap.ticketId);
      console.log(`     · [L${gap.level ?? '?'}] ${question}`);
    }
    if (list.length > perSubject) {
      console.log(`     … and ${list.length - perSubject} more (--limit to see further)`);
    }
  }

  console.log(`\n${gaps.length} tickets in total wanted an answer the library did not hold.\n`);
}

/** How many investigations each subject had at all, so a count can be a share. */
async function investigatedPerSubject(supabase, byId) {
  const runs = await supabaseSelectAll(supabase, 'ticket_investigations', {}, 'ticket_id');
  const totals = new Map();
  for (const run of runs) {
    const ticket = byId.get(run.ticket_id);
    if (!ticket) continue;
    const subject = ticket.category || '(uncategorised)';
    totals.set(subject, (totals.get(subject) ?? 0) + 1);
  }
  return totals;
}

/**
 * The customer's own first message, trimmed to one line.
 *
 * THEIR WORDS, NOT THE SUBJECT LINE. Half this corpus arrives as « Nouveau
 * message de client le 12 août », which names nothing — and somebody deciding
 * what to write needs the question, not the envelope.
 */
async function firstQuestion(supabase, ticketId) {
  const rows = await supabaseSelectAll(
    supabase,
    'ticket_messages',
    { ticket_id: ticketId, direction: 'inbound' },
    'body_text,received_at',
    { order: 'received_at.asc', limit: 1 }
  );
  const body = String(rows?.[0]?.body_text ?? '').replace(/\s+/g, ' ').trim();
  return body.length > 150 ? `${body.slice(0, 150)}…` : body || '(no message body)';
}

function valueOf(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1];
}

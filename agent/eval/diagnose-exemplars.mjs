import {
  createSupabaseClient,
  supabaseSelect,
  supabaseSelectAll
} from '../../scripts/lib/supabase-rest-client.mjs';
import { createEmbeddingsClient } from '../../scripts/lib/embeddings/openai-embeddings-client.mjs';
import { buildExemplarEmbeddingInput } from '../../scripts/lib/embeddings/embedding-input.mjs';
import { cosine, parseVector } from '../../scripts/lib/cluster-messages.mjs';
import { partitionBy } from '../../scripts/lib/message-audience.mjs';

import { loadAgentConfig } from '../src/config.mjs';
import { resolveShopId } from '../src/lib/shop.mjs';
import { createSenderDirectoryStore } from '../src/ingestion/sender-directory.mjs';
import { MATCHED, NEAR } from '../src/retrieval/exemplar-rules.mjs';

// Do the 32 exemplars actually match real mail, and where do the bands belong?
//
// EMBEDS IN MEMORY, WRITES NOTHING. Approval gates the vector, so no exemplar is
// retrievable yet — and calibrating the bands is exactly the evidence a reviewer
// needs BEFORE approving. Scoring against vectors that already exist breaks that
// deadlock: `ticket_messages.embedding` was written at ingestion, so the query
// side is free and only the 79 phrasings cost an API call. The same trick the
// knowledge library was assessed with before its chunks were approved.
//
// THERE IS NO LABELLED SET, so this does not report precision. It reports
// DISTRIBUTIONS plus one derived signal: whether the winning exemplar's subject
// agrees with the subject the categoriser independently assigned to the ticket.
// That is a proxy and it is stated as one — two situations under `promotions`
// can still be the wrong one of the two — but it is free, it covers every real
// ticket rather than a hand-labelled dozen, and it splits the score distribution
// the way a labelled set would.
//
//   npm run eval:exemplars

const BUCKETS = [0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.8];

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);

  const exemplars = await loadExemplars(supabase, shopId);
  if (exemplars.length === 0) {
    console.log('No exemplars. Run `npm run import:exemplars` from the repo root first.');
    return;
  }

  const phrasings = exemplars.flatMap((e) => e.phrasings);
  console.log(
    `${exemplars.length} exemplar(s), ${phrasings.length} phrasing(s) — embedding in memory ` +
      '(nothing is written).\n'
  );

  const embeddingsClient = createEmbeddingsClient({
    apiKey: config.openaiApiKey,
    model: config.embeddingModel,
    dimensions: config.embeddingDimensions
  });
  const vectors = await embeddingsClient.embed(
    phrasings.map((p) => buildExemplarEmbeddingInput({ phrasing_text: p.text }))
  );
  phrasings.forEach((p, i) => {
    p.vector = vectors[i];
  });

  const tickets = await loadTriggerMessages({ supabase, shopId, config });
  console.log(`${tickets.length} real customer ticket(s) with an embedded first message.\n`);

  const results = tickets.map((ticket) => score(ticket, exemplars));

  reportBands(results);
  reportAgreement(results);
  reportMargins(results);
  reportLanguages(results);
  reportCoverage(results, exemplars);
  reportRivals(results, exemplars);
  reportUnmatched(results);
}

/** Best phrasing per exemplar, then the exemplars ranked — the RPC's shape, in JS. */
function score(ticket, exemplars) {
  const ranked = exemplars
    .map((exemplar) => {
      let best = -Infinity;
      let bestPhrasing = null;
      for (const phrasing of exemplar.phrasings) {
        const similarity = cosine(ticket.vector, phrasing.vector);
        if (similarity > best) {
          best = similarity;
          bestPhrasing = phrasing;
        }
      }
      return { exemplar, similarity: best, phrasing: bestPhrasing };
    })
    .sort((a, b) => b.similarity - a.similarity);

  const [top, second] = ranked;
  return {
    ticket,
    // The WHOLE ranking is kept, not just the winner. `reportRivals` needs to ask
    // where a losing exemplar placed and who beat it, and that question cannot be
    // answered from the top row alone. 29 exemplars x ~190 tickets is small.
    ranked,
    top,
    margin: second ? top.similarity - second.similarity : null,
    // The proxy: did the winner land on the subject the categoriser assigned?
    agrees: top.exemplar.category === ticket.category
  };
}

function reportBands(results) {
  console.log('='.repeat(72));
  console.log('WHERE THE BEST MATCH LANDS\n');

  const scores = results.map((r) => r.top.similarity).sort((a, b) => a - b);
  console.log(`  min ${f(scores[0])}  p25 ${f(q(scores, 0.25))}  median ${f(q(scores, 0.5))}  ` +
    `p75 ${f(q(scores, 0.75))}  max ${f(scores[scores.length - 1])}\n`);

  console.log('  cumulative share of tickets whose best match clears a threshold:');
  for (const threshold of BUCKETS) {
    const n = scores.filter((s) => s >= threshold).length;
    const share = Math.round((n / scores.length) * 100);
    const marker = threshold === MATCHED ? '  <- MATCHED' : threshold === NEAR ? '  <- NEAR' : '';
    console.log(`    ${threshold.toFixed(2)}  ${bar(share)} ${String(share).padStart(3)}%  (${n})${marker}`);
  }
  console.log();
}

/**
 * The proxy for relevance. If the bands are any good, the two distributions
 * separate; if they overlap completely, no threshold on this corpus exists and
 * the answer is more phrasings rather than a different number.
 */
function reportAgreement(results) {
  console.log('='.repeat(72));
  console.log('SUBJECT AGREEMENT — a proxy for relevance, not ground truth\n');

  const agreeing = results.filter((r) => r.agrees).map((r) => r.top.similarity).sort((a, b) => a - b);
  const disagreeing = results.filter((r) => !r.agrees).map((r) => r.top.similarity).sort((a, b) => a - b);

  const line = (label, xs) =>
    xs.length === 0
      ? `  ${label.padEnd(12)} none`
      : `  ${label.padEnd(12)} n=${String(xs.length).padStart(3)}  min ${f(xs[0])}  ` +
        `p25 ${f(q(xs, 0.25))}  median ${f(q(xs, 0.5))}  p75 ${f(q(xs, 0.75))}  max ${f(xs[xs.length - 1])}`;

  console.log(line('AGREES', agreeing));
  console.log(line('DISAGREES', disagreeing));

  if (agreeing.length > 0 && disagreeing.length > 0) {
    console.log(
      `\n  Agreement rate overall: ${Math.round((agreeing.length / results.length) * 100)}%.\n`
    );

    // THE SWEEP THAT ACTUALLY SETS THE BAND. Percentiles show the two
    // distributions overlap; only this says what a given threshold costs. Both
    // columns are against the proxy, so read them as shape rather than as truth.
    console.log('  threshold   kept   agreeing   restraint   recall');
    for (const threshold of BUCKETS.filter((b) => b >= 0.5)) {
      const kept = results.filter((r) => r.top.similarity >= threshold);
      if (kept.length === 0) continue;
      const good = kept.filter((r) => r.agrees).length;
      // restraint: of what clears the bar, how much lands on the right subject.
      const restraint = good / kept.length;
      // recall: of every ticket whose winner was right, how much survives.
      const recall = good / agreeing.length;
      console.log(
        `     ${threshold.toFixed(2)}    ${String(kept.length).padStart(4)}   ` +
          `${String(good).padStart(6)}      ${pct(restraint)}      ${pct(recall)}`
      );
    }
  }
  console.log();
}

function reportMargins(results) {
  console.log('='.repeat(72));
  console.log('MARGIN — how far the winner beats the runner-up\n');

  const margins = results.map((r) => r.margin).filter(Number.isFinite).sort((a, b) => a - b);
  console.log(`  median ${f(q(margins, 0.5))}  p25 ${f(q(margins, 0.25))}  p10 ${f(q(margins, 0.1))}`);
  for (const threshold of [0.01, 0.02, 0.03, 0.05]) {
    const n = margins.filter((m) => m < threshold).length;
    console.log(
      `    below ${threshold.toFixed(2)}: ${n} ticket(s) (${Math.round((n / margins.length) * 100)}%) ` +
        'would resolve ambiguous'
    );
  }
  console.log();
}

function reportLanguages(results) {
  const byLanguage = new Map();
  for (const r of results) {
    const key = r.ticket.language || 'unknown';
    if (!byLanguage.has(key)) byLanguage.set(key, []);
    byLanguage.get(key).push(r.top.similarity);
  }
  if (byLanguage.size <= 1) return;

  console.log('='.repeat(72));
  console.log('BY LANGUAGE — the corpus is French; these are the ones that suffer\n');
  for (const [language, scores] of [...byLanguage.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const sorted = [...scores].sort((a, b) => a - b);
    console.log(
      `  ${language.padEnd(8)} n=${String(scores.length).padStart(3)}  median ${f(q(sorted, 0.5))}  ` +
        `clearing ${MATCHED}: ${scores.filter((s) => s >= MATCHED).length}`
    );
  }
  console.log();
}

function reportCoverage(results, exemplars) {
  console.log('='.repeat(72));
  console.log('WHICH EXEMPLARS EARN THEIR PLACE\n');

  const wins = new Map();
  for (const r of results) {
    if (r.top.similarity < NEAR) continue;
    const key = r.top.exemplar.exemplarKey;
    if (!wins.has(key)) wins.set(key, []);
    wins.get(key).push(r.top.similarity);
  }

  const ranked = [...wins.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [key, scores] of ranked.slice(0, 12)) {
    const exemplar = exemplars.find((e) => e.exemplarKey === key);
    const sorted = [...scores].sort((a, b) => a - b);
    console.log(
      `  ${String(scores.length).padStart(3)} ticket(s)  ${key.padEnd(6)} ` +
        `median ${f(q(sorted, 0.5))}  [${exemplar.category}]  ${exemplar.phrasings.length} phrasing(s)`
    );
  }

  const never = exemplars.filter((e) => !wins.has(e.exemplarKey));
  if (never.length > 0) {
    console.log(
      `\n  ${never.length} exemplar(s) never win a ticket above ${NEAR}: ` +
        never.map((e) => e.exemplarKey).join(', ')
    );
    console.log('  Why each one loses is the next section.');
  }
  console.log();
}

/**
 * WHY a silent exemplar is silent — which the win counts cannot say.
 *
 * "Never wins" has at least three causes and they want opposite fixes:
 *
 * - **Collision.** It is runner-up again and again, losing to the same rival by
 *   a hair. Two exemplars are competing to describe one situation, and the fix
 *   is a MERGE — not more phrasings, which would only sharpen the tie.
 * - **Absence.** It is never even close on any ticket. Nobody writes in about
 *   this, and the fix is to accept that and leave it, or to cut it.
 * - **Register or language.** Its best tickets are all non-French, or all
 *   mid-thread. The exemplar is fine; the corpus it is being scored against
 *   cannot show it off. R-22 is the worked example: its only real phrasing comes
 *   from the fourth message of a thread, and this eval scores first messages
 *   only, so it was structurally unable to win anything.
 *
 * The verdicts below are SIGNALS, not a classifier — all three can be true at
 * once, so all three are printed rather than collapsed into one label.
 */
function reportRivals(results, exemplars) {
  const winners = new Set(
    results.filter((r) => r.top.similarity >= NEAR).map((r) => r.top.exemplar.exemplarKey)
  );
  const silent = exemplars.filter((e) => !winners.has(e.exemplarKey));
  if (silent.length === 0 || results.length === 0) return;

  console.log('='.repeat(72));
  console.log('WHY THE SILENT ONES LOSE — collision, absence, or wrong corpus\n');

  for (const exemplar of silent) {
    // Where this exemplar placed on every ticket, best placement first.
    const placings = results
      .map((r) => {
        const rank = r.ranked.findIndex((x) => x.exemplar.exemplarKey === exemplar.exemplarKey);
        return { result: r, rank, similarity: r.ranked[rank].similarity };
      })
      .sort((a, b) => b.similarity - a.similarity);

    const best = placings[0];
    const runnerUp = placings.filter((p) => p.rank === 1);

    // Who beats it when it comes second, and by how much.
    const rivals = new Map();
    for (const p of runnerUp) {
      const key = p.result.top.exemplar.exemplarKey;
      if (!rivals.has(key)) rivals.set(key, []);
      rivals.get(key).push(p.result.top.similarity - p.similarity);
    }
    const [topRival] = [...rivals.entries()].sort((a, b) => b[1].length - a[1].length);

    // The language of the tickets it comes closest to winning.
    const languages = [...new Set(placings.slice(0, 5).map((p) => p.result.ticket.language || '?'))];

    console.log(
      `  ${exemplar.exemplarKey.padEnd(6)} [${exemplar.category}]  ${exemplar.phrasings.length} phrasing(s)  ` +
        `best ${f(best.similarity)}  runner-up on ${runnerUp.length} ticket(s)`
    );

    if (best.similarity < NEAR) {
      console.log(
        `         ABSENT — never comes within ${NEAR} of any ticket. Rare here, not mis-worded.`
      );
    }
    if (topRival) {
      const gaps = [...topRival[1]].sort((a, b) => a - b);
      const median = q(gaps, 0.5);
      // A gap of zero is not a close call, it is the same text scored twice —
      // the signature of a merge whose retired row is still in the table.
      const verdict =
        median === 0
          ? 'DUPLICATE — identical phrasing, almost certainly a retired key still in the table'
          : median < 0.05
            ? 'COLLISION — merge candidate'
            : 'loses clearly, not a tie';
      console.log(
        `         beaten ${topRival[1].length}x by ${topRival[0]}, median gap ${f(median)} — ${verdict}`
      );
    }
    // Never wins, never even second, yet scores respectably: no single rival to
    // merge with. The situation is being described well enough by the field as a
    // whole that this row adds nothing.
    if (!topRival && best.similarity >= NEAR) {
      console.log(
        '         MID-PACK — never in the top two on any ticket, yet not far off. ' +
          'No one rival to merge with; the field covers it.'
      );
    }
    if (!languages.includes('fr')) {
      console.log(
        `         its closest tickets are ${languages.join('/')} — language, not phrasing.`
      );
    }
    console.log(`         closest ticket: "${excerpt(best.result.ticket.text)}"`);
    console.log();
  }
}

function reportUnmatched(results) {
  const unmatched = results.filter((r) => r.top.similarity < NEAR);
  if (unmatched.length === 0) return;

  console.log('='.repeat(72));
  console.log(`${unmatched.length} TICKET(S) MATCH NOTHING — the situations still missing\n`);
  for (const r of unmatched.slice(0, 10)) {
    console.log(`  ${f(r.top.similarity)} [${r.ticket.category}] "${excerpt(r.ticket.text)}"`);
  }
  console.log();
}

// --- loading -----------------------------------------------------------------

async function loadExemplars(supabase, shopId) {
  const rows = await supabaseSelect(
    supabase,
    'support_exemplars',
    { shop_id: shopId },
    'id,exemplar_key,canonical_question,category'
  );
  const phrasings = await supabaseSelectAll(
    supabase,
    'support_exemplar_phrasings',
    {},
    'support_exemplar_id,phrasing_text,phrasing_kind'
  );

  const byExemplar = new Map(rows.map((r) => [r.id, []]));
  for (const p of phrasings) {
    byExemplar.get(p.support_exemplar_id)?.push({ text: p.phrasing_text, kind: p.phrasing_kind });
  }

  return rows
    .map((r) => ({
      exemplarKey: r.exemplar_key,
      question: r.canonical_question,
      category: r.category,
      phrasings: byExemplar.get(r.id) || []
    }))
    .filter((e) => e.phrasings.length > 0);
}

/**
 * The first inbound message of each customer ticket — the one an investigation
 * would actually run against. Later messages in a thread are replies to us and
 * would inflate the corpus with our own vocabulary.
 */
async function loadTriggerMessages({ supabase, shopId, config }) {
  const tickets = await supabaseSelectAll(
    supabase,
    'tickets',
    { category: { operator: 'not.is', value: 'null' }, deleted_at: { operator: 'is', value: 'null' } },
    'id,category,language'
  );
  const byTicket = new Map(tickets.map((t) => [t.id, t]));

  const messages = await supabaseSelectAll(
    supabase,
    'ticket_messages',
    {
      direction: 'inbound',
      embedding: { operator: 'not.is', value: 'null' },
      deleted_at: { operator: 'is', value: 'null' }
    },
    'id,ticket_id,from_email,body_text,embedding,sent_at'
  );

  const directory = await createSenderDirectoryStore(supabase).load(shopId, {
    supportMailbox: config.supportMailbox
  });
  const { customer } = partitionBy(messages, (from) => directory.isNonDemand(from));

  const firstByTicket = new Map();
  for (const message of customer) {
    const ticket = byTicket.get(message.ticket_id);
    if (!ticket) continue;
    const existing = firstByTicket.get(message.ticket_id);
    if (!existing || String(message.sent_at) < String(existing.sent_at)) {
      firstByTicket.set(message.ticket_id, message);
    }
  }

  return [...firstByTicket.entries()].map(([ticketId, message]) => ({
    ticketId,
    category: byTicket.get(ticketId).category,
    language: byTicket.get(ticketId).language,
    text: message.body_text,
    vector: parseVector(message.embedding)
  }));
}

// --- formatting --------------------------------------------------------------

const f = (n) => (Number.isFinite(n) ? n.toFixed(3) : '—');
const q = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const pct = (x) => `${String(Math.round(x * 100)).padStart(3)}%`;
const bar = (share) => '█'.repeat(Math.round(share / 4)).padEnd(25);
const excerpt = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 70);

import {
  createSupabaseClient,
  supabaseSelectAll
} from '../../scripts/lib/supabase-rest-client.mjs';

import { loadAgentConfig } from '../src/config.mjs';
import { resolveShopId } from '../src/lib/shop.mjs';

// Does the authored corpus describe what real tickets actually require?
//
// Two independent declarations of the same thing exist on every investigated
// ticket, and this compares them:
//
//   the EXEMPLAR's `requirement_needs`  — written by a person, per situation
//   the RUN's `evidence_gaps`           — emitted by the decomposer, per ticket
//
// THE INDEPENDENCE IS THE WHOLE MEASUREMENT. Nothing in the investigation reads
// the exemplar, so agreement between the two is evidence about the corpus rather
// than an artefact of wiring. Rows where the exemplar SUPPLIED the needs — the
// decomposition-failure fallback — are excluded by name below, because there the
// two are the same list and including them would manufacture agreement.
//
// WHAT THE ANSWER IS FOR. If the corpus systematically declares needs the model
// misses, combining the two at decomposition time is worth building. If it
// declares fewer, or the same, a union is a no-op and the exemplar's value is
// elsewhere. That decision should rest on this table rather than on intuition.
//
//   npm run eval:exemplar-needs

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
    'ticket_id,verdict,exemplar_match,evidence_gaps,investigated_at'
  );

  const committed = rows.filter((r) => r.exemplar_match?.exemplar_key);
  const usable = committed.filter((r) => !r.exemplar_match.supplied_needs);
  const excluded = committed.length - usable.length;

  console.log(`${rows.length} investigation(s)`);
  console.log(`  ${committed.length} with a committed exemplar match`);
  if (excluded > 0) {
    console.log(`  ${excluded} excluded: the exemplar supplied the needs (not independent)`);
  }
  console.log(`  ${usable.length} comparable\n`);

  if (usable.length === 0) {
    console.log('Nothing to compare yet. Run `npm run investigate` over more tickets —');
    console.log('only tickets whose best match CLEARS the MATCHED band produce a row here.');
    reportNearMisses(rows);
    return;
  }

  const buckets = { exact: [], subset: [], superset: [], overlap: [], disjoint: [] };

  for (const row of usable) {
    const declared = new Set(row.exemplar_match.requirement_needs || []);
    const resolved = new Set((row.evidence_gaps || []).map((g) => g.need));
    const shared = [...declared].filter((n) => resolved.has(n));
    const onlyExemplar = [...declared].filter((n) => !resolved.has(n));
    const onlyRun = [...resolved].filter((n) => !declared.has(n));

    const bucket =
      shared.length === 0 ? 'disjoint'
        : onlyExemplar.length === 0 && onlyRun.length === 0 ? 'exact'
          : onlyExemplar.length === 0 ? 'subset'
            : onlyRun.length === 0 ? 'superset'
              : 'overlap';

    buckets[bucket].push({ row, onlyExemplar, onlyRun, shared });
  }

  console.log('='.repeat(74));
  console.log('HOW THE TWO DECLARATIONS RELATE\n');
  const label = {
    exact: 'exact          the same needs, both sides',
    subset: 'subset         the run required MORE than the exemplar declared',
    superset: 'superset       the exemplar declared MORE than the run required',
    overlap: 'overlap        each named something the other did not',
    disjoint: 'disjoint       no need in common'
  };
  for (const [name, entries] of Object.entries(buckets)) {
    const share = Math.round((entries.length / usable.length) * 100);
    console.log(`  ${String(entries.length).padStart(3)} (${String(share).padStart(3)}%)  ${label[name]}`);
  }

  // THE NUMBER THE DECISION TURNS ON. A union at decomposition time is only
  // worth building if the exemplar names needs the run genuinely missed.
  const missedByRun = new Map();
  for (const name of ['superset', 'overlap']) {
    for (const entry of buckets[name]) {
      for (const need of entry.onlyExemplar) {
        missedByRun.set(need, (missedByRun.get(need) || 0) + 1);
      }
    }
  }

  console.log('\n' + '='.repeat(74));
  console.log('NEEDS THE EXEMPLAR DECLARED AND THE RUN DID NOT\n');
  if (missedByRun.size === 0) {
    console.log('  none — the corpus never named a requirement the run missed.');
    console.log('  On this evidence a union at decomposition time would be a no-op.\n');
  } else {
    for (const [need, n] of [...missedByRun.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(3)}x  ${need}`);
    }
    console.log('\n  These are the case for combining the two declarations.');
    console.log('  Gate any such union on verdict === matched — never near or ambiguous.\n');
  }

  console.log('='.repeat(74));
  console.log('PER TICKET\n');
  for (const [name, entries] of Object.entries(buckets)) {
    for (const { row, onlyExemplar, onlyRun } of entries) {
      const m = row.exemplar_match;
      console.log(
        `  ${m.exemplar_key.padEnd(6)} ${String(m.similarity).padEnd(6)} ${name.padEnd(9)} ` +
          `${row.verdict}`
      );
      if (onlyExemplar.length) console.log(`      exemplar only: ${onlyExemplar.join(', ')}`);
      if (onlyRun.length) console.log(`      run only     : ${onlyRun.join(', ')}`);
    }
  }
}

/**
 * Committed matches are the minority, so a run with none is the normal early
 * state rather than a failure. Saying how close the rest came is what tells you
 * whether to wait for more tickets or to look at the band.
 */
function reportNearMisses(rows) {
  const near = rows
    .map((r) => r.exemplar_match)
    .filter((m) => m && Number.isFinite(m.similarity));
  if (near.length === 0) return;

  const sorted = near.map((m) => m.similarity).sort((a, b) => b - a);
  console.log(`\n  ${near.length} row(s) did retrieve something. Best scores: ` +
    sorted.slice(0, 5).map((s) => s.toFixed(3)).join(', '));
  console.log('  Their closest situations: ' +
    [...new Set(near.map((m) => m.closest).filter(Boolean))].join(', '));
}

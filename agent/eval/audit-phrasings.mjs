// Finds phrasings filed under the wrong situation, two ways.
//
// 1. MISFILED — use the phrasing's own stored vector as a query and ask which
//    exemplar it retrieves. Its own row is excluded (it would score 1.0 against
//    itself), so the parent is represented by its SIBLINGS. A phrasing closer to
//    another situation than to its own siblings is the signal.
//
//    The known false positive: an exemplar whose only sibling is the tidy
//    canonical question. The canonical always scores lower than a real phrasing,
//    so thin exemplars flag easily — the margin column is what separates a real
//    misfiling from that artefact.
//
// 2. MULTI-INTENT — a phrasing whose text carries more than one question. These
//    are the cause rather than the symptom: one message describing two
//    situations can only ever be filed half-wrongly.
import {
  createSupabaseClient,
  supabaseSelect,
  supabaseSelectAll
} from '../../scripts/lib/supabase-rest-client.mjs';
import { cosine, parseVector } from '../../scripts/lib/cluster-messages.mjs';
import { loadAgentConfig } from '../src/config.mjs';
import { resolveShopId } from '../src/lib/shop.mjs';

const config = loadAgentConfig();
const supabase = createSupabaseClient(config);
const shopId = await resolveShopId(supabase, config.shopDomain);

const exemplars = await supabaseSelect(
  supabase, 'support_exemplars', { shop_id: shopId }, 'id,exemplar_key,category'
);
const raw = await supabaseSelectAll(
  supabase, 'support_exemplar_phrasings', {},
  'id,support_exemplar_id,phrasing_index,phrasing_kind,phrasing_text,embedding'
);
const byId = new Map(exemplars.map((e) => [e.id, e]));

const rows = raw
  .filter((p) => byId.has(p.support_exemplar_id) && p.embedding)
  .map((p) => ({
    ...p,
    key: byId.get(p.support_exemplar_id).exemplar_key,
    category: byId.get(p.support_exemplar_id).category,
    vector: parseVector(p.embedding)
  }))
  .filter((p) => p.vector);

console.log(`${rows.length} embedded phrasings across ${exemplars.length} exemplars\n`);

// --- 1. misfiled ---------------------------------------------------------------
console.log('='.repeat(78));
console.log('MISFILED — the phrasing retrieves a situation that is not its own\n');

const findings = [];
for (const p of rows) {
  const perExemplar = new Map();
  for (const other of rows) {
    if (other.id === p.id) continue;              // never score a row against itself
    const s = cosine(p.vector, other.vector);
    if (!perExemplar.has(other.key) || s > perExemplar.get(other.key).s) {
      perExemplar.set(other.key, { s, text: other.phrasing_text, kind: other.phrasing_kind });
    }
  }
  const ranked = [...perExemplar.entries()].sort((a, b) => b[1].s - a[1].s);
  const [topKey, top] = ranked[0];
  const own = perExemplar.get(p.key);
  if (topKey === p.key) continue;

  findings.push({
    p, topKey, top,
    ownScore: own ? own.s : null,
    margin: top.s - (own ? own.s : 0)
  });
}

findings.sort((a, b) => b.margin - a.margin);
for (const f of findings) {
  console.log(`  ${f.p.key} #${f.p.phrasing_index} (${f.p.phrasing_kind})  ->  retrieves ${f.topKey}  ` +
    `${f.top.s.toFixed(3)} vs own siblings ${f.ownScore === null ? 'n/a' : f.ownScore.toFixed(3)}  ` +
    `(margin ${f.margin.toFixed(3)})`);
  console.log(`      "${f.p.phrasing_text.slice(0, 96)}"`);
  console.log(`      beaten by ${f.topKey}: "${f.top.text.slice(0, 84)}"`);
  console.log();
}
if (findings.length === 0) console.log('  none\n');

// --- 2. multi-intent -----------------------------------------------------------
console.log('='.repeat(78));
console.log('MULTI-INTENT — one phrasing carrying more than one question\n');

const CONNECTORS = /\b(par ailleurs|de plus|également|et puis-?je|autre question|par la même occasion|d'autre part|ainsi que ma)\b/i;
const suspects = rows.filter((p) => {
  const marks = (p.phrasing_text.match(/\?/g) || []).length;
  return marks >= 2 || CONNECTORS.test(p.phrasing_text);
});
for (const p of suspects) {
  const marks = (p.phrasing_text.match(/\?/g) || []).length;
  const hit = CONNECTORS.exec(p.phrasing_text);
  console.log(`  ${p.key} #${p.phrasing_index}  ${marks} question mark(s)${hit ? `, connector « ${hit[0]} »` : ''}`);
  console.log(`      "${p.phrasing_text.slice(0, 150)}"`);
  console.log();
}
if (suspects.length === 0) console.log('  none\n');

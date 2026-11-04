import { loadConfig, loadEnv } from '../lib/sync-config.mjs';
import { createSupabaseClient, supabaseSelect, supabaseSelectAll } from '../lib/supabase-rest-client.mjs';
import { loadCatalogue } from '../lib/storefront-chat/product-repository.mjs';
import { loadAdvisoryConfig } from '../lib/advisory/advisory-repository.mjs';
import fs from 'node:fs';
import { buildAdvisorKnowledge, loadAdvisorKnowledge } from '../lib/advisory/advisor-knowledge.mjs';
import { knowledgeIndex } from '../lib/advisory/product-knowledge.mjs';
import { createAdvisor } from '../lib/advisory/recommend.mjs';
import { createAdvisorTurn } from '../lib/storefront-chat/advisor-tools.mjs';

// THE ADVICE ENGINE ALONE, on the live catalogue and the shop's active knowledge, with no
// model and no chat session: what the engine picks for a few turns. READ-ONLY (selects only).
//
//   node scripts/advisor/try-advice.mjs "Je veux un seul produit" "profile:primary_concern:imperfections"
//
// Each argument is one turn; `profile:<field>:<value>` is a chip click, anything else is words.
// --local: the knowledge built from data/advisor/qiriness-knowledge.json + -routine-settings.json
// (what `npm run advisor:load` would write), to try a settings change before loading it.

const env = loadEnv();
const db = createSupabaseClient(loadConfig(env));
const reader = { selectAll: (t, f, c) => supabaseSelectAll(db, t, f, c) };
const [shop] = await supabaseSelect(db, 'shops', { shop_domain: env.SHOPIFY_STORE_DOMAIN }, 'id');
const catalogue = await loadCatalogue(reader, shop.id);
const raw = await loadAdvisoryConfig(reader, shop.id);
const local = process.argv.includes('--local');
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const built = local ? buildAdvisorKnowledge({ sheet: read('data/advisor/qiriness-knowledge.json'), settings: read('data/advisor/qiriness-routine-settings.json') }) : null;
if (built?.errors.length) throw new Error(built.errors.join(' | '));
const loaded = local ? { knowledge: knowledgeIndex(built.products), routines: built.routines } : await loadAdvisorKnowledge(reader, shop.id);
const advisor = createAdvisor(raw, catalogue, loaded ? { knowledge: loaded.knowledge, routines: loaded.routines } : {});
const byId = new Map(catalogue.products.map((p) => [p.id, p]));
const money = (n) => `${Number(n).toFixed(2)} €`;

let state = null;
for (const [i, said] of process.argv.slice(2).filter((a) => a !== '--local').entries()) {
  const choice = said.startsWith('profile:') ? said : null;
  const t = createAdvisorTurn({ advisor, state, message: choice ? said.split(':').pop() : said, choice, catalogue, money, turn: i + 1, consultation: true });
  t.opening();
  const a = t.advice;
  console.log(`\n> ${said}   [engine ${advisor.engine}, mode ${t.mode}]`);
  console.log('  profile:', JSON.stringify(Object.fromEntries(Object.entries(t.profile).map(([k, v]) => [k, v?.value]))));
  if (!a) { console.log('  (no advice)'); } else {
    console.log('  status:', a.status, '| playbook:', a.playbook?.key ?? null, '| scope:', a.scope ?? null, a.budget ? `| budget ${JSON.stringify(a.budget)}` : '');
    for (const s of a.steps ?? []) {
      const p = byId.get(s.product_id);
      console.log(`  step ${s.slot ?? s.kind}: ${p?.name} (${p?.priceFrom ?? '?'})${s.top_choices ? ' [top_choices]' : ''}`);
      for (const x of s.alternatives ?? []) console.log(`      alt: ${byId.get(x.product_id)?.name} (${byId.get(x.product_id)?.priceFrom ?? '?'})`);
    }
    if (a.next_question) console.log('  next_question:', a.next_question.field, a.next_question.options?.map((o) => o.value).join(','));
  }
  state = t.nextState();
}

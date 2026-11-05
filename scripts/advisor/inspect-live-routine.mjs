import { loadConfig, loadEnv } from '../lib/sync-config.mjs';
import { createSupabaseClient, supabaseSelect, supabaseSelectAll } from '../lib/supabase-rest-client.mjs';
import { loadCatalogue } from '../lib/storefront-chat/product-repository.mjs';
import { loadAdvisoryConfig } from '../lib/advisory/advisory-repository.mjs';
import { loadAdvisorKnowledge } from '../lib/advisory/advisor-knowledge.mjs';
import { createAdvisor } from '../lib/advisory/recommend.mjs';

// READ ONLY. The routine the live storefront chat builds, from what production loads: the shop's
// catalogue, its advisory config and its ACTIVE advisor_knowledge (not the local sheet copy).
//
//   node scripts/advisor/inspect-live-routine.mjs                      « Taches et teint terne », normal, 25–34, night
//   node scripts/advisor/inspect-live-routine.mjs dark_spots+dullness dry 25_34 both

const [concern = 'dark_spots+dullness', skin = 'normal', age = '25_34', time = 'night'] = process.argv.slice(2);
const env = loadEnv();
const db = createSupabaseClient(loadConfig(env));
const reader = { selectAll: (t, f, c) => supabaseSelectAll(db, t, f, c) };
const [shop] = await supabaseSelect(db, 'shops', { shop_domain: env.SHOPIFY_STORE_DOMAIN }, 'id');
const catalogue = await loadCatalogue(reader, shop.id);
const raw = await loadAdvisoryConfig(reader, shop.id);
const loaded = await loadAdvisorKnowledge(reader, shop.id);
console.log('active knowledge version:', loaded?.version ?? 'NONE (playbooks run)');
const advisor = createAdvisor(raw, catalogue, loaded ? { knowledge: loaded.knowledge, routines: loaded.routines } : {});

const D = loaded?.routines?.foundations?.find((f) => (f.primary_concerns ?? []).includes('dullness'));
console.log('foundation for dullness:', D ? { key: D.key, preferred_range: D.preferred_range, range_by_age: D.range_by_age ?? false } : null);

const watched = /eclat-parfait|active-energie|regard-energie|regard-eclat/;
console.log('\nproducts of the two ranges, as production sees them:');
for (const p of catalogue.products.filter((x) => watched.test(x.handle))) {
  const k = loaded?.knowledge?.get?.(p.handle) ?? null;
  console.log(` ${p.inStock ? 'in stock ' : 'OUT      '} ${String(p.priceFrom).padStart(6)}  ${p.handle}  range=${k?.range ?? '—'} type=${k?.functional_type ?? '—'} time=${k?.time_of_day ?? '—'} status=${k?.status ?? 'NOT IN KNOWLEDGE'}`);
}

// The chip's value, read the way the builder reads it (« dark_spots+dullness »: main + second concern).
const q = (value) => ({ value, source: 'quick_choice', confidence: 'high', turn: 1 });
const [main, ...more] = concern.split('+').reverse();
const profile = { primary_concern: q(main), ...(more.length ? { secondary_concerns: q(more) } : {}), skin_type: q(skin), age_band: q(age), routine_time: q(time) };
const a = advisor.advise({ profile, mode: 'routine_builder', asked: ['primary_concern', 'skin_type', 'age_band', 'routine_time'] });
console.log(`\n${concern} · ${skin} · ${age} · ${time} → ${a.status}, range ${a.playbook?.preferred_family ?? '—'}`);
for (const part of ['day', 'night']) for (const s of a.moments?.[part] ?? []) console.log(` ${part.padEnd(5)} ${s.preselected === false ? '( )' : '(x)'} ${s.handle}  ${(s.reason_codes ?? []).join(',')}`);

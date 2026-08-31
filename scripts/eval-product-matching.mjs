import { loadConfig, loadEnv } from './lib/sync-config.mjs';
import { createSupabaseClient, supabaseSelectAll } from './lib/supabase-rest-client.mjs';
import { buildProductIndex, matchProduct } from '../agent/src/retrieval/product-matching.mjs';

// 50 questions worded the way people write them, against the LIVE catalogue.
//
//   npm run eval:matching
//
// FREE TO RUN, which is the point of testing this layer here rather than through
// the agent. `matchProduct` is pure — IDF over titles, no model and no
// embeddings — so this costs one read of the product table and nothing else. The
// same 50 questions against exemplar matching would be 50 embedding calls, and
// against a full investigation several hundred model calls.
//
// EXPECTATIONS ARE A JUDGEMENT, NOT GROUND TRUTH. A pass means the matcher agrees
// with what a person thought the right answer was; cases where that is genuinely
// arguable are marked `soft` and reported separately, so a change that moves them
// is visible rather than silently scored.
//
// The four shapes it exists to separate: one product, a range, a real ambiguity,
// and a question that named no product at all.
const CASES = [
  // --- 1. specific products, names chopped the way a human types them --------
  ['la crème yeux regard d’exception', 'product', /Crème Yeux Anti-Âge Regard/],
  ['votre contour des yeux caresse regard énergie', 'product', /Caresse Regard Énergie/],
  ['la crème contour des yeux regard sublime', 'product', /Caresse Regard Sublime/],
  ['le démaquillant yeux biphasé', 'product', /Regard Velours/],
  ['la crème mains velours', 'product', /Mains Velours/],
  ['votre baume à lèvres lip beauty', 'product', /Lip Beauty/],
  ['la BB crème peau parfaite', 'product', /BB Crème Peau Parfaite/],
  ['la CC crème bonne mine', 'product', /CC Crème/],
  ['la brume sensi zen', 'product', /Sensi Zen/],
  ['la crème sensi zen apaisante', 'product', /Caresse Sensi Zen/],
  ['crème source d’eau riche pour peau sèche', 'product', /Source d.Eau Riche/],
  ['le voile source d’eau matifiant', 'product', /Voile Source d.Eau/],
  ['la crème homme acide hyaluronique niacinamide', 'product', /Crème Anti-Âge Homme/],
  ['le baume visage homme peaux sèches', 'product', /Visage Homme/],
  ['la crème éclat parfait anti-taches', 'product', /Éclat Parfait/],
  ['le déodorant fleur d’oranger', 'product', /Déodorant/],
  ['les galets effervescents du bain lacté', 'product', /Bain Lacté/],
  ['la crème temps sublime light', 'product', /Temps Sublime Light/],
  ['la crème temps sublime riche au rétinol', 'product', /Temps Sublime Riche/],
  ['la crème de nuit caresse temps sublime', 'product', /Crème Nuit Anti-Âge/],
  ['crème anti-rides caresse d’exception', 'product', /Caresse d.Exception/],
  ['les patchs regard d’or', 'product', /Regard d.Or/],

  // --- 2. ranges ------------------------------------------------------------
  ['la gamme temps sublime est-elle adaptée aux peaux sensibles ?', 'range', 'temps sublime'],
  ['toute la gamme source d’eau', 'range', 'source eau'],
  ['la gamme caresse active énergie', 'range', 'active energie'],
  ['la ligne sensi zen convient-elle aux peaux réactives ?', 'range', 'sensi zen'],
  ['la collection regard, que contient-elle ?', 'range', null, 'soft'],
  ['toute la gamme hyal-aqua', 'range', 'hyal aqua', 'soft'],
  ['la gamme wrap exfolys', 'range', 'wrap exfolys', 'soft'],
  ['la famille temps sublime en entier', 'range', 'temps sublime'],

  // --- 3. LED vs cosmetic mask, from context --------------------------------
  ['mon masque LED ne se recharge plus', 'product', /Masque LED/],
  ['le masque led visage éclat et régénération', 'product', /Masque LED/],
  ['votre masque lumineux ne s’allume plus', 'product', /Masque LED/, 'soft'],
  ['la batterie de mon masque ne tient pas la charge', 'product', /Masque LED/, 'soft'],
  ['la télécommande du masque ne fonctionne plus', 'product', /Masque LED/, 'soft'],
  ['combien de séances par semaine avec le masque ?', 'product', /Masque LED/, 'soft'],
  ['le masque exfoliant grenade citron', 'product', /Grenade Citron/],
  ['le masque argile thermo-purifiant terre d’orient', 'product', /Terre d.Orient/],
  ['le masque repulpant wrap d’or', 'product', /Wrap d.Or/],
  ['le masque hydratant aloe vera wrap d’eau', 'product', /Wrap d.Eau/],
  ['le masque visage matifiant wrap purifiant', 'product', /Wrap Purifiant/],
  ['le masque pieds hydratant', 'product', /Masque Pieds/],
  ['le masque mains hydra-repair', 'product', /Masque Mains/],
  ['combien de temps dois-je laisser poser le masque ?', 'ambiguous', null, 'soft'],

  // --- 4. general questions that name no product ----------------------------
  ['vos produits sont-ils testés sur les animaux ?', 'none', 'no_product_named'],
  ['est-ce que 100% de vos produits sont vegan ?', 'none', 'no_product_named'],
  ['quels sont vos délais de livraison ?', 'none', 'no_product_named'],
  ['je voudrais faire évoluer ma routine de soins du visage', 'none', null, 'soft'],
  ['bonjour, où en est ma commande ?', 'none', 'no_product_named'],
  ['avez-vous une boutique à Paris ?', 'none', 'no_product_named']
];

const config = loadConfig(loadEnv());
const supabase = createSupabaseClient(config);
const shopId = (await supabaseSelectAll(supabase, 'shops', {}, 'id'))[0].id;
const products = await supabaseSelectAll(
  supabase,
  'products',
  { shop_id: shopId, status: 'active' },
  'id,title,handle,status,product_type'
);
const index = buildProductIndex(products);

let hard = { pass: 0, fail: 0 };
let soft = { pass: 0, fail: 0 };
const failures = [];

for (const [question, expect, want, softness] of CASES) {
  const r = matchProduct(question, index);
  const got = r.range ? 'range' : r.match ? 'product' : r.ambiguous ? 'ambiguous' : 'none';

  let ok = got === expect;
  let detail = '';
  if (ok && expect === 'product') {
    ok = want.test(r.match.title);
    detail = r.match.title.trim().slice(0, 48);
  } else if (ok && expect === 'range') {
    ok = want === null || r.range.name === want;
    detail = `${r.range.name} (${r.range.products.length})`;
  } else if (ok && expect === 'none') {
    ok = want === null || r.reason === want;
    detail = r.reason;
  } else if (got === 'product') {
    detail = r.match.title.trim().slice(0, 48);
  } else if (got === 'range') {
    detail = `${r.range.name} (${r.range.products.length})`;
  } else if (got === 'ambiguous') {
    detail = r.tied.map((p) => p.title.trim().slice(0, 22)).join(' | ');
  } else {
    detail = r.reason ?? '';
  }

  const bucket = softness === 'soft' ? soft : hard;
  if (ok) bucket.pass += 1;
  else {
    bucket.fail += 1;
    failures.push({ question, expect, got, detail, soft: softness === 'soft' });
  }
}

console.log(`\nHARD cases  ${hard.pass}/${hard.pass + hard.fail} pass`);
console.log(`SOFT cases  ${soft.pass}/${soft.pass + soft.fail} pass   (arguable — my expectation may be wrong)`);
console.log(`TOTAL       ${hard.pass + soft.pass}/${CASES.length}\n`);

if (failures.length > 0) {
  console.log('FAILURES');
  for (const f of failures) {
    console.log(`  ${f.soft ? '~' : '✗'} ${f.question}`);
    console.log(`      expected ${f.expect}, got ${f.got}${f.detail ? ` → ${f.detail}` : ''}`);
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { loadConfig, loadEnv } from '../lib/sync-config.mjs';
import { createSupabaseClient, supabaseSelect, supabaseSelectAll } from '../lib/supabase-rest-client.mjs';
import { signAppProxyQuery } from '../lib/storefront-chat/app-proxy-signature.mjs';
import { loadCatalogue } from '../lib/storefront-chat/product-repository.mjs';
import { loadKnowledge } from '../lib/storefront-chat/knowledge-repository.mjs';
import { createShoppingReader } from '../lib/storefront-chat/shopping-repository.mjs';
import { getActivePromotions } from '../lib/storefront-chat/shopping-evaluator.mjs';
import { asksToAdd } from '../lib/storefront-chat/routine-flow.mjs';
import { createOpenAIClient } from '../../agent/src/llm/openai-client.mjs';
import { estimateCost } from '../lib/llm-rates.mjs';
import {
  JUDGE_SCHEMA, JUDGE_SYSTEM, applyAdds, cartFromFixture, customerView, describeCart, emptyCart, judgePrompt, parseIds, planRuns, sheetRow
} from '../lib/storefront-chat/stress-plan.mjs';

// THE LAUNCH STRESS TEST, RUN AND GRADED (data/advisor/Qiriness_Chatbot_Launch_Stress_Tests_200.xlsx).
// Each message goes to the chat endpoint exactly as the Shopify app proxy sends it (signed,
// storefront context, the widget's basket snapshot), so it is the real advisor, its real model,
// the live catalogue. A second model grades each reply against the test's « Critère de réussite »,
// given the shop's live facts (catalogue, offers, policies) and what the advisor can do.
// The results are written into a COPY of the workbook: « Pilotage » and « Smoke 25 » fill in.
//
//   npm run advisor:stress -- --smoke              the 25 smoke tests (start here)
//   npm run advisor:stress -- --only 101,271-275   some tests (a scenario turn runs its scenario up to it)
//   npm run advisor:stress -- --all                all 200
//   npm run advisor:stress -- --smoke --no-judge   send and record only, grade by hand
//   npm run advisor:stress -- --regrade data/advisor/stress-runs/<run>.json [--only <ids>]
//                                                 grade a saved run again (after a grader change);
//                                                 sends nothing to the advisor, writes no session
//
//   --url <endpoint>   default http://localhost:3000/api/storefront/chat (npm --prefix web run dev)
//   --judge-model <m>  default gpt-6-sol;  --concurrency <n>  conversations at once, default 3
//
// WRITES: one chat session per test or scenario to the configured database, like any visitor
// (the session ids are in « Notes QA »), and counts against the shop's daily chat cap.
// Fixtures (basket, page, test customer) per test: data/advisor/stress-fixtures.json.
// Output: data/advisor/stress-runs/<time>-<label>.xlsx and .json (ignored by git).

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const env = loadEnv();
const workbook = flag('--file') ?? 'data/advisor/Qiriness_Chatbot_Launch_Stress_Tests_200.xlsx';
const endpoint = flag('--url') ?? 'http://localhost:3000/api/storefront/chat';
const judgeModel = flag('--judge-model') ?? 'gpt-6-sol';
const concurrency = Math.max(1, Math.min(8, Number(flag('--concurrency') ?? 3)));
const judging = !args.includes('--no-judge');
const shop = String(env.STOREFRONT_CHAT_ALLOWED_SHOPS ?? '').split(',')[0].trim();
const python = process.platform === 'win32' ? 'python' : 'python3';
const SHEET_SCRIPT = path.join('scripts', 'advisor', 'stress-sheet.py');
const TURN_TIMEOUT_MS = 120_000;
// Five sends in a row failing is the server, not the advisor (2026-11-02: a dev server rebuilding
// answered 404 to all 175 tests): stop instead of filling the workbook with « Bloqué ».
const MAX_FAILURES_IN_A_ROW = 5;
let failuresInARow = 0;

if (!shop) fail('No shop: set STOREFRONT_CHAT_ALLOWED_SHOPS.');
if (!env.STOREFRONT_APP_CLIENT_SECRET) fail('STOREFRONT_APP_CLIENT_SECRET is not set.');
const regrade = flag('--regrade');
if (!regrade && !args.some((a) => ['--smoke', '--only', '--all'].includes(a))) fail('Choose the tests: --smoke, --only <ids>, --all, or --regrade <run.json>.');
if (regrade && !judging) fail('--regrade grades: drop --no-judge.');

// ---------------------------------------------------------------- the workbook
const read = spawnSync(python, [SHEET_SCRIPT, 'read', workbook], { encoding: 'utf8', maxBuffer: 64 << 20 });
if (read.status !== 0) {
  console.error(read.stderr || read.error?.message || 'could not read the workbook');
  if (/openpyxl/.test(read.stderr ?? '')) console.error(`Install the reader once: ${python} -m pip install openpyxl`);
  process.exit(1);
}
const sheet = JSON.parse(read.stdout);
const wanted = regrade || args.includes('--all') ? null : args.includes('--smoke') ? new Set(sheet.smoke) : parseIds(flag('--only'));
const runs = regrade ? [] : planRuns(sheet.tests, wanted);
const fixtures = JSON.parse(fs.readFileSync('data/advisor/stress-fixtures.json', 'utf8'));
const label = regrade ? 'regrade' : args.includes('--all') ? 'all' : args.includes('--smoke') ? 'smoke' : 'only';

// ---------------------------------------------------------------- the shop's facts, for the grader
const db = createSupabaseClient(loadConfig(env));
const reader = { selectAll: (t, f, c) => supabaseSelectAll(db, t, f, c) };
const [catalogueShop] = await supabaseSelect(db, 'shops', { shop_domain: env.SHOPIFY_STORE_DOMAIN }, 'id');
if (!catalogueShop) fail(`catalogue shop ${env.SHOPIFY_STORE_DOMAIN} not found`);
const catalogue = await loadCatalogue(reader, catalogueShop.id);
const facts = judging ? await shopFacts() : '';
const nameOf = (id) => catalogue.products.find((p) => p.shopifyId === id || p.id === id)?.name ?? null;

/**
 * The full sheet of each product the conversation names (card, link or name): what the advisor
 * itself reads (description, usage, ingredients, FAQ). Without it the grader took true usage
 * instructions (« 20 à 30 minutes ») for inventions (full run, 2026-11-02).
 */
function productDetails(transcript) {
  const said = transcript.map((t) => `${t.message}\n${t.view}`).join('\n').toLowerCase();
  const named = catalogue.products.filter((p) => said.includes(`/products/${p.handle}`) || said.includes(p.name.toLowerCase()));
  if (!named.length) return '';
  const cut = (t, n) => (t ? String(t).slice(0, n) : null);
  return ['', 'FICHES DES PRODUITS NOMMÉS DANS LA CONVERSATION (ce que le chat lit) :', ...named.slice(0, 8).map((p) => [
    `### ${p.name} (/products/${p.handle})`,
    p.short && `Résumé : ${cut(p.short, 600)}`,
    p.description && `Description : ${cut(p.description, 1800)}`,
    p.usage && `Utilisation : ${cut(p.usage, 800)}`,
    p.keyIngredients && `Actifs : ${cut(p.keyIngredients, 600)}`,
    p.volume && `Contenance : ${p.volume}`,
    p.claims?.length && `Allégations : ${p.claims.join(' ; ')}`,
    ...(p.faqs ?? []).slice(0, 6).map((f) => `FAQ — ${f.canonical_question} → ${cut(f.answer, 500)}`)
  ].filter(Boolean).join('\n'))].join('\n');
}

async function shopFacts() {
  const knowledge = await loadKnowledge(reader, catalogueShop.id);
  const shopping = await createShoppingReader(reader)(env.SHOPIFY_STORE_DOMAIN);
  const euros = (n) => `${Number(n).toFixed(2).replace('.', ',')} €`;
  const products = catalogue.products.map((p) => {
    const variants = p.variants.map((v) => `${v.title ?? 'unique'} ${euros(v.price)}${v.compareAt ? ` (barré ${euros(v.compareAt)})` : ''}${v.inStock === false ? ' ÉPUISÉ' : ''}`).join(' ; ');
    return `- ${p.name} | /products/${p.handle} | ${p.type ?? '?'} | ${variants} | ${p.inStock ? 'en stock' : 'ÉPUISÉ'}`;
  });
  const offers = getActivePromotions(shopping, { limit: 12 });
  const parameters = [...(knowledge.parameters ?? new Map())].filter(([, v]) => v !== null && v !== '').map(([k, v]) => `- ${k} = ${v}`);
  const policies = knowledge.policies.map((p) => `### ${p.name}\n${String(p.content ?? '').slice(0, 2500)}`);
  return [
    `CATALOGUE PUBLIÉ (${products.length} produits ; un produit absent n’existe pas en vente) :`, ...products, '',
    'PROMOTIONS PUBLIQUES EN COURS (lecture de la base, synchronisée depuis Shopify) :', JSON.stringify(offers.promotions ?? [], null, 0),
    `Règles de cumul : ${JSON.stringify(offers.stacking_rules ?? null)}`, '',
    'PARAMÈTRES DE LA BOUTIQUE :', ...parameters, '',
    'POLITIQUES VALIDÉES POUR LE CHAT :', ...policies
  ].join('\n');
}

// ---------------------------------------------------------------- one turn, as the app proxy sends it
async function send({ message, choice = null, sessionId, cart, page, customer }) {
  const url = new URL(endpoint);
  url.searchParams.set('shop', shop);
  url.searchParams.set('logged_in_customer_id', customer ? String(customer) : '');
  url.searchParams.set('path_prefix', '/apps/storefront-advisor');
  url.searchParams.set('timestamp', String(Math.floor(Date.now() / 1000)));
  url.searchParams.set('signature', signAppProxyQuery(url.searchParams, env.STOREFRONT_APP_CLIENT_SECRET));
  const context = {
    pageType: page?.pageType ?? 'index', productHandle: page?.productHandle ?? null, collectionHandle: page?.collectionHandle ?? null,
    locale: 'fr', country: 'FR', currency: 'EUR', loggedIn: Boolean(customer),
    path: page?.productHandle ? `/products/${page.productHandle}` : page?.collectionHandle ? `/collections/${page.collectionHandle}` : '/'
  };
  const started = performance.now();
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message, choice, context, cart }),
    signal: AbortSignal.timeout(TURN_TIMEOUT_MS)
  });
  const seconds = Math.round((performance.now() - started) / 100) / 10;
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${body?.error?.code ?? ''}`.trim());
  return { ...body, seconds };
}

// ---------------------------------------------------------------- the grader
const judgeClient = judging ? createOpenAIClient({ apiKey: env.OPENAI_API_KEY, usageSink: { record: (u) => usage.push(u) } }) : null;
const usage = [];

async function judge(test, transcript, setup) {
  if (!judging) return null;
  try {
    return await judgeClient.completeJson({
      model: judgeModel, system: JUDGE_SYSTEM, user: judgePrompt({ test, transcript, setup, facts: facts + productDetails(transcript) }),
      schema: JUDGE_SCHEMA, schemaName: 'stress_verdict', maxTokens: 1200, pass: 'stress_judge'
    });
  } catch (error) {
    return { verdict: 'Non testé', failure_type: '', reason: `[notation impossible] ${error.message}`, human_check: 'noter à la main' };
  }
}

/** The state the turn was sent in, as the grader reads it (ÉTAT RÉEL DU TEST). */
function setupText({ key, multi, turnNo, fixture, cart }) {
  const page = fixture.page ?? null;
  return `${multi ? `conversation « ${key} », tour ${turnNo}` : 'nouveau chat'} ; ${fixture.customer ? 'cliente de test connectée' : 'visiteur non connecté'} ; page ${page?.productHandle ? `/products/${page.productHandle}` : 'accueil'} ; panier ${cart ? describeCart(cart) : 'voir les tours précédents'} ; pays FR, EUR.${fixture._todo ? ` Fixture manquante : ${fixture._todo}.` : ''}`;
}

/** --regrade: the saved replies judged again; a turn that was not sent stays as it was. */
async function regradeRun(file, only) {
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')).results;
  const byId = new Map(sheet.tests.map((t) => [t.id, t]));
  const views = new Map(saved.map((r) => [r.id, r]));
  return pool(saved.filter((r) => !only || only.has(r.id)), concurrency, async (r) => {
    const test = byId.get(r.id);
    if (!test || !r.reply) return [{ test: test ?? { id: r.id, priority: '' }, setup: r.setup ?? null, raw: r.raw, row: r }];
    const turns = test.scenario ? sheet.tests.filter((t) => t.scenario === test.scenario && Number(t.turn) <= Number(test.turn)).sort((a, b) => Number(a.turn) - Number(b.turn)) : [test];
    const transcript = turns.map((t) => ({ message: t.message, view: views.get(t.id)?.reply ?? '(tour non conservé)' }));
    const fixture = fixtures[String(turns[0].id)] ?? {};
    const setup = r.setup ?? setupText({ key: test.scenario || String(test.id), multi: Boolean(test.scenario), turnNo: turns.length, fixture, cart: test.scenario ? null : fixture.cart ? cartFromFixture(fixture.cart, catalogue) : emptyCart() });
    const verdict = await judge(test, transcript, setup);
    const sessionId = /\[session ([0-9a-f-]{36})\]/.exec(r.notes ?? '')?.[1] ?? null;
    const row = sheetRow({ test, view: r.reply, seconds: r.total, verdict, error: null, sessionId, date: r.date });
    console.log(`${String(test.id).padEnd(4)} ${test.priority}  ${r.result.padEnd(14)} → ${row.result.padEnd(14)} ${verdict?.reason ?? ''}`.slice(0, 230));
    return [{ test, setup, raw: r.raw, row }];
  });
}

// ---------------------------------------------------------------- a run: one test, or one scenario's turns
async function run({ key, tests }) {
  const fixture = fixtures[String(tests[0].id)] ?? {};
  const customer = fixture.customer ?? null;
  const page = fixture.page ?? null;
  let cart = fixture.cart ? cartFromFixture(fixture.cart, catalogue) : emptyCart();
  let sessionId = null;
  let broken = null;
  const transcript = [];
  const rows = [];
  for (const test of tests) {
    const date = new Date().toISOString().slice(0, 10);
    const setup = setupText({ key, multi: tests.length > 1, turnNo: transcript.length + 1, fixture, cart });
    if (broken) {
      rows.push({ test, row: sheetRow({ test, view: null, seconds: null, verdict: null, error: `tour précédent non envoyé (${broken})`, sessionId, date }) });
      continue;
    }
    try {
      if (failuresInARow >= MAX_FAILURES_IN_A_ROW) throw new Error('run stopped: the endpoint failed 5 times in a row');
      const turn = await send({ message: test.message, sessionId, cart, page, customer });
      failuresInARow = 0;
      sessionId = turn.sessionId;
      let view = customerView(turn.reply, nameOf);
      cart = applyAdds(cart, turn.reply?.cart?.add, catalogue);
      const raw = [turn.reply];
      // An add request is answered with « Oui, ajouter »: the customer who asked clicks it, and the
      // test is judged on what reaches the basket (the add is the widget's, on that click).
      const yes = asksToAdd(test.message) ? (turn.reply?.choices ?? []).find((c) => c.value === 'flow:cart:yes') : null;
      if (yes) {
        const click = await send({ message: yes.label, choice: yes.value, sessionId, cart, page, customer });
        cart = applyAdds(cart, click.reply?.cart?.add, catalogue);
        raw.push(click.reply);
        view += `
[la cliente clique « ${yes.label} »]
${customerView(click.reply, nameOf)}
[panier après le clic] ${describeCart(cart)}`;
      }
      transcript.push({ message: test.message, view });
      const verdict = await judge(test, transcript, setup);
      rows.push({ test, setup, raw: raw.length > 1 ? raw : turn.reply, row: sheetRow({ test, view, seconds: turn.seconds, verdict, error: null, sessionId, date }) });
      const r = rows[rows.length - 1].row;
      console.log(`${String(test.id).padEnd(4)} ${test.priority}  ${r.result.padEnd(14)} ${String(turn.seconds).padStart(5)} s  ${verdict?.reason ?? ''}`.slice(0, 220));
    } catch (error) {
      if (!/^run stopped/.test(error.message)) failuresInARow += 1;
      broken = error.message;
      rows.push({ test, row: sheetRow({ test, view: null, seconds: null, verdict: null, error: error.message, sessionId, date }) });
      console.log(`${String(test.id).padEnd(4)} ${test.priority}  Bloqué         not sent: ${error.message}`);
    }
  }
  return rows;
}

async function pool(items, size, worker) {
  const out = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next; next += 1; out[i] = await worker(items[i]); }
  }));
  return out.flat();
}

// ---------------------------------------------------------------- go
let results;
if (regrade) {
  console.log(`grading ${regrade} again with ${judgeModel} (nothing is sent to the advisor)\n`);
  results = await regradeRun(regrade, flag('--only') ? parseIds(flag('--only')) : null);
} else {
  const turns = runs.reduce((n, r) => n + r.tests.length, 0);
  console.log(`${turns} turns in ${runs.length} conversations → ${endpoint} (${shop})${judging ? `, graded by ${judgeModel}` : ', not graded'}\n`);
  results = await pool(runs, concurrency, run);
}
if (failuresInARow >= MAX_FAILURES_IN_A_ROW) {
  const first = results.find((r) => r.row.result === 'Bloqué')?.row.notes.split('\n')[0] ?? '';
  fail(`\nStopped: the chat endpoint failed ${MAX_FAILURES_IN_A_ROW} times in a row (${first}). Is ${endpoint} the running dev server? Nothing written.`);
}

const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const dir = path.join('data', 'advisor', 'stress-runs');
fs.mkdirSync(dir, { recursive: true });
const base = path.join(dir, `${stamp}-${label}`);
fs.writeFileSync(`${base}.json`, `${JSON.stringify({ workbook, endpoint, shop, judgeModel: judging ? judgeModel : null, results: results.map((r) => ({ id: r.test.id, ...r.row, setup: r.setup ?? null, raw: r.raw ?? null })) }, null, 1)}\n`);
fs.writeFileSync(`${base}.rows.json`, JSON.stringify(results.map((r) => r.row)));
const written = spawnSync(python, [SHEET_SCRIPT, 'write', workbook, `${base}.xlsx`, `${base}.rows.json`], { encoding: 'utf8' });
fs.rmSync(`${base}.rows.json`, { force: true });

// ---------------------------------------------------------------- summary
const by = (v) => results.filter((r) => r.row.result === v);
const p0 = by('Échec').filter((r) => r.test.priority === 'P0');
const times = results.map((r) => r.row.total).filter((t) => typeof t === 'number').sort((a, b) => a - b);
const cost = usage.reduce((n, u) => n + estimateCost({ model: u.model, inputTokens: u.usage?.prompt_tokens ?? 0, outputTokens: u.usage?.completion_tokens ?? 0, cachedInputTokens: u.usage?.prompt_tokens_details?.cached_tokens ?? 0 }).totalUsd, 0);
console.log(`\nRéussi ${by('Réussi').length} · Échec ${by('Échec').length} (P0 ${p0.length}) · Bloqué ${by('Bloqué').length} · Non applicable ${by('Non applicable').length} · Non testé ${by('Non testé').length}`);
if (times.length) console.log(`time per reply: median ${times[Math.floor(times.length / 2)]} s, max ${times[times.length - 1]} s (local dev server)`);
if (judging) console.log(`grading: ${usage.length} calls, ≈ $${cost.toFixed(2)}`);
for (const r of p0) console.log(`  P0 ${r.test.id}  ${r.test.message}\n       ${r.row.notes.split('\n')[0]}`);
if (written.status !== 0) {
  console.error(`\nworkbook not written: ${written.stderr}`);
  console.log(`results: ${base}.json`);
  process.exit(1);
}
console.log(`\nworkbook: ${base}.xlsx\nraw replies: ${base}.json`);

function fail(message) {
  console.error(message);
  process.exit(1);
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createAdvisor } from './recommend.mjs';
import { validateConfig } from './config.mjs';
import { TEMPLATE_KEYS, coveredHandles, knowledgeIndex, parseKnowledgeRows } from './product-knowledge.mjs';
import { durationsDisagree, expectedInterval, isScheduled, measuredIndex, replenishment } from './replenishment.mjs';
import { customerRanges, describePurchases, emptyPurchaseState, purchaseItems } from '../storefront-chat/purchase-turn.mjs';

// Phases 2 and 3 of purchase history on the INVENTED sample set
// (data/advisor/sample/: no real product, price or customer) under the real
// playbooks, so the routines are the ones customers would get.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const CONFIG = read('data/advisor/qiriness.json');
const CATALOGUE = read('data/advisor/sample/catalogue.json');
const SHEET = read('data/advisor/sample/knowledge.json');
const MEASURED = measuredIndex(read('data/advisor/sample/repurchase.json'));
const parsed = parseKnowledgeRows(SHEET.rows, { concerns: SHEET.concerns });
const KNOWLEDGE = knowledgeIndex(parsed.products);
const advisor = createAdvisor(CONFIG, CATALOGUE, { knowledge: KNOWLEDGE });
const id = (handle) => CATALOGUE.products.find((p) => p.handle === handle).id;
const q = (field, value) => ({ value, source: 'quick_choice', confidence: 'high', turn: 1 });
const dryProfile = (scope) => ({ primary_concern: q('primary_concern', 'dryness'), skin_type: q('skin_type', 'dry'), routine_scope: q('routine_scope', scope) });
const handlesOf = (advice) => advice.steps.map((s) => s.handle);

test('the sample is complete: every product has every column of the template, and imports cleanly', () => {
  assert.equal(SHEET.rows.length, CATALOGUE.products.length);
  for (const row of SHEET.rows) {
    assert.deepEqual(Object.keys(row), TEMPLATE_KEYS, row.handle);
    for (const key of TEMPLATE_KEYS.filter((k) => !['kit_contents', 'other_type', 'measured_repurchase_weeks', 'measured_repurchase_detail'].includes(k))) {
      assert.notEqual(String(row[key] ?? '').trim(), '', `${row.handle} ${key}`);
    }
  }
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.products.length, 14);
  const kit = KNOWLEDGE.get('test-coffret-hydratation');
  assert.deepEqual(kit.kit_contents, ['test-lait-nettoyant-doux', 'test-serum-hydratant-aqua', 'test-creme-hydratante-riche']);
  assert.deepEqual(KNOWLEDGE.get('test-serum-anti-age-lift').other_concerns, ['loss_of_firmness', 'fine_lines']);
  assert.deepEqual(KNOWLEDGE.get('test-creme-hydratante-riche').skin, { dry: 'ideal', normal: 'suitable', combination: 'unsuitable', oily: 'unsuitable' });
});

test('the importer rejects what the dropdowns do not allow, and reads a blank as not stated', () => {
  const base = { ...SHEET.rows[0] };
  const one = (over) => parseKnowledgeRows([...SHEET.rows, { ...base, handle: 'test-x', ...over }], { concerns: SHEET.concerns });
  const fieldsOf = (r) => r.errors.filter((e) => e.handle === 'test-x').map((e) => e.field);
  assert.deepEqual(fieldsOf(one({ functional_type: 'Crème de jour' })), ['functional_type']);
  assert.deepEqual(fieldsOf(one({ primary_concern: 'Peau qui tire' })), ['concern']);
  assert.deepEqual(fieldsOf(one({ usage_weeks: '3,5' })), ['usage_weeks']);
  assert.deepEqual(fieldsOf(one({ skin_dry: 'Oui' })), ['skin_dry']);
  assert.deepEqual(fieldsOf(one({ kit_contents: 'test-serum-hydratant-aqua' })), ['kit_contents']);
  assert.deepEqual(fieldsOf(one({ functional_type: 'Coffret', kit_contents: 'test-inconnu' })), ['kit_contents']);
  // Coffret and kit are two types; the old joint label is refused, to be chosen again.
  assert.deepEqual(fieldsOf(one({ functional_type: 'Coffret / kit' })), ['functional_type']);
  const kit = one({ functional_type: 'Kit', kit_contents: 'test-serum-hydratant-aqua' }).products.find((p) => p.handle === 'test-x');
  assert.deepEqual([kit.functional_type, kit.kit_contents], ['kit', ['test-serum-hydratant-aqua']]);
  assert.deepEqual(fieldsOf(one({ other_type: 'Peignoir' })), ['other_type']);
  const other = one({ functional_type: 'Autre', other_type: 'Peignoir' }).products.find((p) => p.handle === 'test-x');
  assert.deepEqual([other.functional_type, other.other_type], ['out_of_routine', 'Peignoir']);
  assert.equal(one({ functional_type: 'Hors routine' }).products.find((p) => p.handle === 'test-x').functional_type, 'out_of_routine');
  assert.equal(one({ time_of_day: 'Toute la journée' }).products.find((p) => p.handle === 'test-x').time_of_day, 'all_day');
  // A sheet mask is a treat and a cream mask is not, whatever the « Petit plaisir » column says.
  assert.equal(one({ functional_type: 'Masque tissu', treat: 'Non' }).products.find((p) => p.handle === 'test-x').treat, true);
  assert.equal(one({ functional_type: 'Masque', treat: 'Oui' }).products.find((p) => p.handle === 'test-x').treat, false);
  assert.equal(one({ functional_type: 'Électrocosmétique' }).products.find((p) => p.handle === 'test-x').functional_type, 'device');
  assert.equal(one({ functional_type: 'Démaquillant' }).products.find((p) => p.handle === 'test-x').functional_type, 'makeup_remover');
  const blank = one({ skin_oily: '', texture: '', men: '' });
  const rec = blank.products.find((p) => p.handle === 'test-x');
  assert.equal(rec.skin.oily, null);
  assert.equal(rec.texture, null);
  assert.equal(rec.men, null);
  const pending = one({ status: 'À valider' });
  assert.deepEqual(pending.skipped, [{ handle: 'test-x', status: 'À valider' }]);
  assert.ok(!pending.products.some((p) => p.handle === 'test-x'));
});

test('the config: a functional type must name step kinds the slots define', () => {
  assert.deepEqual(validateConfig(CONFIG), []);
  const broken = { ...CONFIG, functional_types: { ...CONFIG.functional_types, cream: ['moisturiser', 'day_cream'] } };
  assert.deepEqual(validateConfig(broken), ['functional type cream: no slot has kind day_cream']);
});

test('without purchases, the sample gets the real hydration routine', () => {
  const advice = advisor.advise({ profile: dryProfile('essential') });
  assert.equal(advice.playbook.key, 'face_hydration');
  assert.deepEqual(handlesOf(advice), ['test-serum-hydratant-aqua', 'test-creme-hydratante-riche']);
});

test('Phase 2: the cream they still use fills the cream step; only the serum is recommended', () => {
  const advice = advisor.advise({ profile: dryProfile('essential'), owned: [id('test-creme-hydratante-riche')] });
  assert.deepEqual(handlesOf(advice), ['test-serum-hydratant-aqua']);
  assert.deepEqual(advice.skipped, [{ slot: 'moisturiser', kind: 'moisturiser', reason: 'already_owned', product_id: id('test-creme-hydratante-riche'), handle: 'test-creme-hydratante-riche' }]);
  // Never offered again, not even as an alternative.
  assert.ok(!advice.steps.flatMap((s) => s.alternatives).some((a) => a.handle === 'test-creme-hydratante-riche'));
});

test('Phase 2: a kit they still use counts as what it contains', () => {
  assert.deepEqual(coveredHandles('test-coffret-hydratation', KNOWLEDGE), ['test-lait-nettoyant-doux', 'test-serum-hydratant-aqua', 'test-creme-hydratante-riche']);
  const advice = advisor.advise({ profile: dryProfile('complete'), owned: [id('test-coffret-hydratation')] });
  assert.deepEqual(advice.skipped.filter((s) => s.reason === 'already_owned').map((s) => s.slot), ['cleanser', 'serum', 'moisturiser']);
  assert.deepEqual(handlesOf(advice), ['test-masque-hydratant-wrap']);
});

test('Phase 2: one cream fills one step: owning a day cream still leaves the night cream', () => {
  const profile = { primary_concern: q('primary_concern', 'global_signs_of_ageing'), skin_type: q('skin_type', 'dry'), routine_scope: q('routine_scope', 'complete') };
  const before = advisor.advise({ profile });
  assert.equal(before.playbook.key, 'face_global_anti_age');
  const advice = advisor.advise({ profile, owned: [id('test-creme-hydratante-riche')] });
  const owned = advice.skipped.filter((s) => s.reason === 'already_owned');
  assert.equal(owned.length, 1);
  assert.ok(handlesOf(advice).includes('test-creme-de-nuit-regenerante'));
});

test('Phase 2: a step they asked for by type is not skipped because they own one', () => {
  const profile = { ...dryProfile('targeted'), desired_care_type: q('desired_care_type', 'moisturiser') };
  const advice = advisor.advise({ profile, owned: [id('test-creme-hydratante-light')] });
  assert.ok(!advice.skipped.some((s) => s.reason === 'already_owned'));
  assert.equal(advice.steps[0].kind, 'moisturiser');
});

test('Phase 2 without product knowledge: the step rules decide what an owned product fills', () => {
  const plain = createAdvisor(CONFIG, CATALOGUE);
  const advice = plain.advise({ profile: dryProfile('essential'), owned: [id('test-creme-hydratante-riche')] });
  assert.deepEqual(advice.skipped.map((s) => [s.slot, s.reason]), [['moisturiser', 'already_owned']]);
  // Without knowledge a kit is just a product: it fills no step.
  const kit = plain.advise({ profile: dryProfile('complete'), owned: [id('test-coffret-hydratation')] });
  assert.ok(!kit.skipped.some((s) => s.reason === 'already_owned'));
});

test('« Ne pas conseiller » is never recommended, even where it would fit', () => {
  const all = ['targeted', 'essential', 'complete'].map((scope) => advisor.advise({ profile: dryProfile(scope) }));
  const shown = all.flatMap((a) => a.steps.flatMap((s) => [s.handle, ...s.alternatives.map((x) => x.handle)]));
  assert.ok(!shown.includes('test-creme-ancienne-formule'));
  assert.ok(createAdvisor(CONFIG, CATALOGUE).advise({ profile: dryProfile('essential') }).steps.flatMap((s) => [s.handle, ...s.alternatives.map((x) => x.handle)]).includes('test-creme-ancienne-formule'));
});

test('Phase 3: a range they use nudges the ranking, within suitable products only', () => {
  const profile = { primary_concern: q('primary_concern', 'dryness'), skin_type: q('skin_type', 'combination'), routine_scope: q('routine_scope', 'complete') };
  const plain = advisor.advise({ profile });
  const nudged = advisor.advise({ profile, ranges: ['Gamme Test Pure'] });
  const cleanser = (a) => a.steps.find((s) => s.slot === 'cleanser');
  const pure = (a) => [cleanser(a), ...cleanser(a).alternatives].find((x) => x.handle === 'test-gel-nettoyant-purifiant');
  assert.ok(pure(plain), 'the purifying gel is a candidate');
  assert.equal(cleanser(nudged).handle, 'test-gel-nettoyant-purifiant');
  assert.ok(cleanser(nudged).reason_codes.includes('customer_range:Gamme Test Pure'));
  // An unsuitable product is not lifted: no range makes the rich cream fit oily skin's light texture step first.
  const oily = { ...profile, skin_type: q('skin_type', 'oily') };
  const moist = advisor.advise({ profile: oily, ranges: ['Gamme Test Aqua'] }).steps.find((s) => s.slot === 'moisturiser');
  assert.equal(moist.handle, 'test-creme-hydratante-light');
});

test('Phase 3: only daily care has an interval; measured wins over stated when there is enough data', () => {
  const ctx = { knowledge: KNOWLEDGE, measured: MEASURED };
  assert.equal(isScheduled(KNOWLEDGE.get('test-masque-hydratant-wrap')), false);
  assert.equal(isScheduled(KNOWLEDGE.get('test-coffret-hydratation')), false);
  assert.equal(isScheduled(KNOWLEDGE.get('test-lotion-exfoliante-eclat')), false);
  assert.equal(expectedInterval('test-masque-hydratant-wrap', ctx), null);
  assert.deepEqual(expectedInterval('test-creme-hydratante-riche', ctx), { weeks: 17, source: 'measured' });
  // 6 repurchases are too few: the brand's stated duration.
  assert.deepEqual(expectedInterval('test-lait-nettoyant-doux', ctx), { weeks: 10, source: 'stated' });
  assert.equal(expectedInterval('test-creme-hydratante-riche', { knowledge: null, measured: MEASURED }), null);
});

test('Phase 3: due once the interval has passed, silent once it is long past', () => {
  const ctx = (now) => ({ knowledge: KNOWLEDGE, measured: MEASURED, now: new Date(now) });
  assert.equal(replenishment('test-creme-hydratante-riche', '2026-06-01', ctx('2026-08-01')).due, false);
  assert.deepEqual(replenishment('test-creme-hydratante-riche', '2026-06-01', ctx('2026-10-13')), { due: true, weeks_since: 19, expected_weeks: 17, source: 'measured' });
  assert.equal(replenishment('test-creme-hydratante-riche', '2025-06-01', ctx('2026-10-13')).due, false);
  assert.equal(durationsDisagree(8, 17), true);
  assert.equal(durationsDisagree(10, 17), false);
  assert.equal(durationsDisagree(null, 17), false);
});

test('Phase 3 in the prompt: running low and repeat buys flagged, never for masks, gifts or once answered', () => {
  const summary = { products: [
    { product_id: 'gid://shopify/Product/900007', title: 'x', first_purchased_on: '2026-01-10', last_purchased_on: '2026-06-01', times_purchased: 2, free_gift: false, returned: false },
    { product_id: 'gid://shopify/Product/900011', title: 'x', first_purchased_on: '2026-01-10', last_purchased_on: '2026-06-01', times_purchased: 3, free_gift: false, returned: false },
    { product_id: 'gid://shopify/Product/900004', title: 'x', first_purchased_on: '2026-06-01', last_purchased_on: '2026-06-01', times_purchased: 1, free_gift: true, returned: false },
    { product_id: 'gid://shopify/Product/900002', title: 'x', first_purchased_on: '2026-05-01', last_purchased_on: '2026-05-01', times_purchased: 1, free_gift: false, returned: false },
  ] };
  const items = purchaseItems(summary, CATALOGUE);
  const opts = { knowledge: KNOWLEDGE, measured: MEASURED, now: new Date('2026-10-13') };
  const view = describePurchases(items, emptyPurchaseState(), opts);
  const by = Object.fromEntries(view.purchases.map((p) => [p.name, p]));
  assert.equal(by['Crème Hydratante Riche (test)'].may_be_running_low, true);
  assert.equal(by['Crème Hydratante Riche (test)'].bought_repeatedly, true);
  assert.equal(by['Masque Hydratant Wrap (test)'].may_be_running_low, undefined);
  assert.equal(by['Sérum Hydratant Aqua (test)'].may_be_running_low, undefined);
  assert.equal(by['Gel Nettoyant Purifiant (test)'].may_be_running_low, true);
  const answered = { ...emptyPurchaseState(), running_low: [id('test-creme-hydratante-riche')] };
  assert.equal(describePurchases(items, answered, opts).purchases[0].may_be_running_low, undefined);
  // Without knowledge, nothing is guessed.
  assert.ok(!describePurchases(items, emptyPurchaseState()).purchases.some((p) => p.may_be_running_low));
  // Ranges: bought twice (the cream, the mask) or built around; never the free serum.
  assert.deepEqual(customerRanges(items, emptyPurchaseState(), KNOWLEDGE), ['Gamme Test Aqua']);
  assert.deepEqual(customerRanges(items, { ...emptyPurchaseState(), around: [id('test-gel-nettoyant-purifiant')] }, KNOWLEDGE).sort(), ['Gamme Test Aqua', 'Gamme Test Pure']);
});

test('a pinned product (their interest) takes its step, before the ranking', () => {
  const advice = advisor.advise({ profile: dryProfile('essential'), pinned: [id('test-creme-hydratante-light')] });
  const cream = advice.steps.find((s) => s.slot === 'moisturiser');
  assert.equal(cream.handle, 'test-creme-hydratante-light');
  assert.equal(cream.customer_interest, true);
  assert.ok(cream.reason_codes.includes('customer_interest'));
  assert.deepEqual(advice.pinned, [{ product_id: id('test-creme-hydratante-light'), handle: 'test-creme-hydratante-light', status: 'placed' }]);
  // The best of the rest is still offered as an alternative.
  assert.ok(cream.alternatives.some((a) => a.handle === 'test-creme-hydratante-riche'));
});

test('a pinned product whose step is not in the chosen size brings its step in; none at all is said so', () => {
  const profile = { primary_concern: q('primary_concern', 'global_signs_of_ageing'), skin_type: q('skin_type', 'dry'), routine_scope: q('routine_scope', 'essential') };
  const eyes = advisor.advise({ profile, pinned: [id('test-contour-des-yeux-defatigant')] });
  assert.ok(eyes.steps.some((s) => s.slot === 'eye_care' && s.handle === 'test-contour-des-yeux-defatigant'));
  const hydra = advisor.advise({ profile: dryProfile('essential'), pinned: [id('test-contour-des-yeux-defatigant')] });
  assert.deepEqual(hydra.pinned.map((p) => p.status), ['pinned_no_step']);
});

test('a pinned product that may not be advised is refused, with its reason', () => {
  const advice = advisor.advise({ profile: dryProfile('essential'), pinned: [id('test-creme-ancienne-formule')] });
  assert.deepEqual(advice.pinned, [{ product_id: id('test-creme-ancienne-formule'), handle: 'test-creme-ancienne-formule', status: 'pinned_unavailable', reason: 'not_advised' }]);
  assert.ok(!handlesOf(advice).includes('test-creme-ancienne-formule'));
});

test('a treat: the brand flag first, else the config collections under the price cap; never one excluded', () => {
  const t = advisor.treat({ profile: dryProfile('essential') });
  assert.equal(t.handle, 'test-masque-hydratant-wrap');
  assert.equal(advisor.treat({ profile: dryProfile('essential'), exclude: [id('test-masque-hydratant-wrap')] }), null);
  const plain = createAdvisor(CONFIG, CATALOGUE);
  assert.equal(plain.treat({ profile: dryProfile('essential') }).handle, 'test-masque-hydratant-wrap');
  const capped = createAdvisor({ ...CONFIG, treats: { ...CONFIG.treats, max_price: 10 } }, CATALOGUE);
  assert.equal(capped.treat({ profile: dryProfile('essential') }), null);
  assert.deepEqual(validateConfig({ ...CONFIG, treats: { collections: 'x' } }), ['treats: collections must be a list']);
});

test('one product asked for (targeted): the one they came for, when it suits', () => {
  const advice = advisor.advise({ profile: dryProfile('targeted'), pinned: [id('test-creme-hydratante-light')] });
  assert.deepEqual(handlesOf(advice), ['test-creme-hydratante-light']);
  assert.equal(advisor.advise({ profile: dryProfile('targeted') }).steps.length, 1);
});

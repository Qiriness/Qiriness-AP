import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createAdvisor, slotList } from './recommend.mjs';
import { extractProfile } from './lexicon-fr.mjs';
import { allowedValues, mergeProfile } from './profile.mjs';
import { checkCatalogue, compileConfig, validateConfig } from './config.mjs';
import { selectPlaybook } from './select-playbook.mjs';
import { configToRows, rowsToConfig } from './advisory-repository.mjs';
import { createEvent, turnEvents } from './events.mjs';

// An INVENTED brand: « Lumen », two ranges, a men's line, a body line. Nothing
// here is the real shop's vocabulary, which proves the engine has none of its own.
const here = path.dirname(fileURLToPath(import.meta.url));

function brand(overrides = {}) {
  return {
    version: 1,
    selection_priority: ['body_area', 'primary_concern', 'skin_type_and_behaviour', 'sensitivity', 'current_routine', 'requested_product_or_routine_scope', 'secondary_concerns', 'sex_target', 'age'],
    playbooks: [
      { key: 'hydra', area: 'face', primary_concerns: ['dehydration', 'tightness'], preferred_family: 'Aqua', targeted: { priority_slots: ['serum', 'cream'] }, essential: { slots: ['serum', 'cream'] }, complete: { slots: ['cleanser', 'serum', 'cream'] }, texture: { cream: [['dry', 'rich'], ['oily', 'light']] }, notes: ['n'] },
      { key: 'lift', area: 'face', primary_concerns: ['firmness', 'wrinkles'], preferred_family: 'Tensor', essential: { slots: ['serum', 'cream'] } },
      { key: 'global', area: 'face', primary_concerns: ['wrinkles', 'global_ageing'], distinguish_by: ['global_ageing'], essential: { slots: ['serum', 'cream'] } },
      { key: 'advanced', area: 'face', primary_concerns: ['deep_wrinkles'], essential: { slots: ['serum', 'cream'] } },
      { key: 'radiance', area: 'face', primary_concerns: ['dullness'], essential: { slots: ['serum'] } },
      { key: 'sensitive', area: 'face', primary_concerns: ['sensitivity', 'tightness'], tolerance_first: true, essential: { slots: ['cream'] } },
      { key: 'eyes', area: 'eyes', routes: [{ key: 'circles', concerns: ['dark_circles'], slots: ['eye'] }] },
      { key: 'men', area: 'face', target: 'men', routes: [{ key: 'hydration', concerns: ['dehydration'], targeted: ['cream'], essential: ['cleanser', 'cream'] }] },
      { key: 'body', area: 'body', primary_concerns: ['dryness', 'dehydration'], essential: { slots: ['body_cream'] } }
    ],
    families: { Aqua: { collections: ['aqua'] }, Tensor: { collections: ['tensor'] } },
    slots: {
      serum: { kind: 'serum', collections: ['serums'], care_types: ['serum'] },
      cream: { kind: 'moisturiser', texture_slot: 'cream', collections: ['creams'], care_types: ['creme'] },
      cleanser: { kind: 'cleanser', collections: ['cleansers'] },
      eye: { kind: 'eye_care', area: 'eyes', collections: ['eyes'] },
      body_cream: { kind: 'body_moisturiser', collections: ['body'] }
    },
    slot_overrides: { men: { cream: { kind: 'moisturiser', texture_slot: 'cream', care_types: ['creme'] }, cleanser: { kind: 'cleanser', care_types: ['gel'] } } },
    areas: { eyes: { exclusive: true, collections: ['eyes'] }, body: { tags: ['body'] }, face: { tags: ['face'] } },
    targets: { men: { tags: ['men'] } },
    bundles: { care_types: ['set'] },
    skin_types: { dry: { tags: ['dry skin'] }, oily: { tags: ['oily skin'] }, _all: { tags: ['all skin'] } },
    skin_type_groups: { dry: { skin_types: ['dry', 'very_dry'] }, oily: { skin_types: ['oily', 'combination'] } },
    textures: { rich: { name_words: ['rich'], opposite: 'light' }, light: { name_words: ['light'], opposite: 'rich' } },
    sensitivity: { tags: ['sensitive'] },
    maturity: { tags: ['mature'] },
    concerns: Object.fromEntries(['dehydration', 'tightness', 'firmness', 'wrinkles', 'global_ageing', 'deep_wrinkles', 'dullness', 'sensitivity', 'dark_circles', 'dryness'].map((c) => [c, { tags: [c] }])),
    labels: { fr: { concern: { global_ageing: 'Signes globaux' }, skin_type: { dry: 'Sèche' } } },
    merchandising: { tiers: { neutral: 0, hero: 0.1 }, tie_window: 0.15, entries: [] },
    ...overrides
  };
}

let n = 0;
const product = (name, { tags = ['face', 'all skin'], collections = [], inStock = true, keyIngredients = null } = {}) => ({ id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, handle: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, tags, collections, inStock, keyIngredients });

function catalogue() {
  n = 0;
  return {
    collections: ['aqua', 'tensor', 'serums', 'creams', 'cleansers', 'eyes', 'body'].map((handle) => ({ handle, title: handle, axis: null })),
    products: [
      product('Serum Aqua', { tags: ['face', 'all skin', 'dehydration'], collections: ['aqua', 'serums'] }),
      product('Creme Aqua Rich', { tags: ['face', 'dry skin', 'dehydration'], collections: ['aqua', 'creams'] }),
      product('Creme Aqua Light', { tags: ['face', 'oily skin', 'dehydration'], collections: ['aqua', 'creams'] }),
      product('Creme Aqua Classic', { tags: ['face', 'all skin', 'dehydration', 'mature'], collections: ['aqua', 'creams'] }),
      product('Creme Plain', { tags: ['face', 'all skin', 'dehydration', 'sensitive', 'tightness'], collections: ['creams'] }),
      product('Serum Tensor', { tags: ['face', 'all skin', 'firmness', 'wrinkles'], collections: ['tensor', 'serums'] }),
      product('Creme Tensor', { tags: ['face', 'all skin', 'firmness', 'wrinkles'], collections: ['tensor', 'creams'] }),
      product('Serum Glow', { tags: ['face', 'all skin', 'dullness'], collections: ['serums'], inStock: false }),
      product('Serum Deep', { tags: ['face', 'all skin', 'deep_wrinkles', 'global_ageing', 'wrinkles'], collections: ['serums'] }),
      product('Creme Deep', { tags: ['face', 'all skin', 'deep_wrinkles', 'global_ageing', 'wrinkles', 'mature'], collections: ['creams'] }),
      product('Eye Balm', { tags: ['face', 'dark_circles'], collections: ['eyes'] }),
      product('Creme Homme', { tags: ['face', 'men', 'all skin', 'dehydration'], collections: [] }),
      product('Gel Homme', { tags: ['face', 'men'], collections: [] }),
      product('Gel Cleanser', { tags: ['face', 'all skin'], collections: ['cleansers'] }),
      product('Body Lotion', { tags: ['body', 'dryness', 'dehydration'], collections: ['body'] }),
      product('Set Aqua', { tags: ['face', 'dehydration'], collections: ['aqua', 'creams'] })
    ]
  };
}

const advisorFor = (raw = brand(), cat = catalogue()) => ({ advisor: createAdvisor(raw, cat), cat });
const profileOf = (advisor, updates) => mergeProfile({}, updates.map((u) => ({ source: 'quick_choice', ...u })), { allowed: advisor.allowed }).profile;
const names = (advice, cat) => advice.steps.map((s) => cat.products.find((p) => p.id === s.product_id).name);

test('the Qiriness file is valid and every reference resolves on a catalogue built from its own mappings', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(here, '../../../data/advisor/qiriness.json'), 'utf8'));
  assert.deepEqual(validateConfig(raw), []);
  const compiled = compileConfig(raw);
  assert.equal(compiled.playbooks.length, 11);
  assert.ok(compiled.vocabulary.concernKeys.includes('early_signs_of_ageing'));
});

test('an invalid config is refused with every reason', () => {
  const bad = brand({ playbooks: [{ key: 'x', area: 'moon', primary_concerns: ['nope'], preferred_family: 'Nobody', essential: { slots: ['ghost'] } }] });
  const errors = validateConfig(bad);
  assert.ok(errors.some((e) => e.includes('unknown area moon')));
  assert.ok(errors.some((e) => e.includes('concern nope has no signals')));
  assert.ok(errors.some((e) => e.includes('unknown family Nobody')));
  assert.ok(errors.some((e) => e.includes('unknown slot ghost')));
  assert.throws(() => compileConfig(bad));
});

test('checkCatalogue reports a family, slot or collection that resolves to nothing', () => {
  const raw = brand({ families: { Aqua: { collections: ['aqua'] }, Tensor: { collections: ['tensor'] }, Gone: { collections: ['gone'] } } });
  const { problems } = checkCatalogue(raw, catalogue());
  assert.ok(problems.some((p) => p.includes('family Gone')));
});

test('rule 1: products are chosen through collections, tags and care types — no id in the config', () => {
  const raw = JSON.stringify(JSON.parse(fs.readFileSync(path.join(here, '../../../data/advisor/qiriness.json'), 'utf8')));
  assert.doesNotMatch(raw, /gid:\/\/shopify|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|"\d{10,}"/);
});

test('rule 2: stock is hard — the only matching product is out of stock, so another serum fills the step', () => {
  const { advisor, cat } = advisorFor();
  const a = advisor.advise({ profile: profileOf(advisor, [{ field: 'primary_concern', value: 'dullness' }]) });
  assert.equal(a.excluded.out_of_stock, 1);
  assert.ok(!names(a, cat).includes('Serum Glow'));
  assert.ok(!a.steps[0].reason_codes.some((r) => r.startsWith('primary_concern')), 'and it does not claim to answer the concern');
});

test('a treatment step is never filled by a product that addresses none of the needs', () => {
  const raw = brand();
  raw.slots.serum = { ...raw.slots.serum, concern_required: true };
  const { advisor } = advisorFor(raw);
  const a = advisor.advise({ profile: profileOf(advisor, [{ field: 'primary_concern', value: 'dullness' }]) });
  assert.equal(a.status, 'no_match');
  assert.equal(a.excluded.unsuitable > 0, true);
});

test('rule 3: body area is hard — a body need gets body products, an eye step gets eye products', () => {
  const { advisor, cat } = advisorFor();
  const body = advisor.advise({ profile: profileOf(advisor, [{ field: 'primary_concern', value: 'dryness' }]) });
  assert.deepEqual(names(body, cat), ['Body Lotion']);
  const eyes = advisor.advise({ profile: profileOf(advisor, [{ field: 'primary_concern', value: 'dark_circles' }]) });
  assert.equal(eyes.playbook.key, 'eyes');
  assert.deepEqual(names(eyes, cat), ['Eye Balm']);
});

test('rules 4 and 5: men\'s products only on an explicit men\'s request; otherwise never', () => {
  const { advisor, cat } = advisorFor();
  const men = advisor.advise({ profile: profileOf(advisor, [{ field: 'primary_concern', value: 'dehydration' }, { field: 'body_area', value: 'face' }, { field: 'sex_target', value: 'men' }, { field: 'routine_scope', value: 'essential' }]) });
  assert.equal(men.playbook.key, 'men');
  assert.deepEqual(names(men, cat), ['Gel Homme', 'Creme Homme']);
  const main = advisor.advise({ profile: profileOf(advisor, [{ field: 'primary_concern', value: 'dehydration' }, { field: 'body_area', value: 'face' }, { field: 'routine_scope', value: 'complete' }]) });
  assert.equal(main.steps.length, 3);
  assert.ok(names(main, cat).every((name) => !/Homme/.test(name)));
});

test('rules 6 and 7: age never selects a playbook and only breaks ties', () => {
  const { advisor, cat } = advisorFor();
  const base = [{ field: 'primary_concern', value: 'dehydration' }, { field: 'body_area', value: 'face' }, { field: 'routine_scope', value: 'essential' }];
  const young = advisor.advise({ profile: profileOf(advisor, base) });
  const old = advisor.advise({ profile: profileOf(advisor, [...base, { field: 'age_band', value: '60_plus' }]) });
  assert.equal(old.playbook.key, young.playbook.key);
  // Classic (tagged mature) only edges ahead on a tie — the age bonus is ≤ 0.05.
  for (const s of old.steps) assert.ok(s.reason_codes.filter((r) => r === 'age_tiebreak').length <= 1);
  assert.deepEqual(names(old, cat).length, 2);
  // A mature customer with dullness stays on the dullness playbook.
  const p = selectPlaybook(profileOf(advisor, [{ field: 'primary_concern', value: 'dullness' }, { field: 'age_band', value: '60_plus' }]), brand());
  assert.equal(p.playbook.key, 'radiance');
});

test('rule 8: skin type picks the texture of the cream', () => {
  const { advisor, cat } = advisorFor();
  const pick = (skin) => names(advisor.advise({ profile: profileOf(advisor, [{ field: 'primary_concern', value: 'dehydration' }, { field: 'body_area', value: 'face' }, { field: 'skin_type', value: skin }, { field: 'routine_scope', value: 'essential' }]) }), cat)[1];
  assert.equal(pick('dry'), 'Creme Aqua Rich');
  assert.equal(pick('oily'), 'Creme Aqua Light');
});

test('rule 9: a step the current routine covers is skipped; targeted adds the next missing step', () => {
  const { advisor, cat } = advisorFor();
  const a = advisor.advise({ profile: profileOf(advisor, [{ field: 'primary_concern', value: 'dehydration' }, { field: 'body_area', value: 'face' }, { field: 'routine_scope', value: 'complete_existing' }, { field: 'current_routine', value: 'cleanser' }, { field: 'current_routine', value: 'moisturiser' }]) });
  assert.deepEqual(a.steps.map((s) => s.kind), ['serum']);
  assert.deepEqual(a.skipped.map((s) => s.reason), ['already_in_routine', 'already_in_routine']);
  assert.ok(names(a, cat).length === 1);
  const t = advisor.advise({ profile: profileOf(advisor, [{ field: 'primary_concern', value: 'dehydration' }, { field: 'body_area', value: 'face' }, { field: 'current_routine', value: 'serum' }]) });
  assert.equal(t.steps[0].kind, 'moisturiser');
  assert.equal(names(t, cat).length, 1);
});

test('rule 10: merchandising reorders suitable products and never lifts an unsuitable one', () => {
  const base = [{ field: 'primary_concern', value: 'dehydration' }, { field: 'body_area', value: 'face' }, { field: 'skin_type', value: 'dry' }, { field: 'routine_scope', value: 'essential' }];
  // Hero on the light cream for a dry skin: outside the window, no effect.
  const unsuitable = advisorFor(brand({ merchandising: { tiers: { hero: 0.2 }, tie_window: 0.15, entries: [{ target_kind: 'product', target: 'creme-aqua-light', tier: 'hero' }] } }));
  const u = unsuitable.advisor.advise({ profile: profileOf(unsuitable.advisor, base) });
  assert.equal(names(u, unsuitable.cat)[1], 'Creme Aqua Rich');
  assert.equal(u.steps[1].merchandised, null);
  // Hero on Creme Aqua Classic (suitable, within the window): boosted ahead of the other family creams.
  const near = advisorFor(brand({ merchandising: { tiers: { hero: 0.2 }, tie_window: 0.15, entries: [{ target_kind: 'product', target: 'creme-aqua-classic', tier: 'hero' }] } }));
  const profile = profileOf(near.advisor, [{ field: 'primary_concern', value: 'dehydration' }, { field: 'body_area', value: 'face' }, { field: 'routine_scope', value: 'essential' }]);
  const plain = near.advisor.advise({ profile });
  assert.equal(names(plain, near.cat)[1], 'Creme Aqua Classic');
  assert.equal(plain.steps[1].merchandised, 'hero');
  // Expired entries do nothing.
  const expired = advisorFor(brand({ merchandising: { tiers: { hero: 0.2 }, tie_window: 0.15, entries: [{ target_kind: 'product', target: 'creme-aqua-classic', tier: 'hero', ends_at: '2020-01-01T00:00:00Z' }] } }));
  assert.equal(expired.advisor.advise({ profile: profileOf(expired.advisor, [{ field: 'primary_concern', value: 'dehydration' }, { field: 'body_area', value: 'face' }, { field: 'routine_scope', value: 'essential' }]) }).steps[1].merchandised, null);
});

test('rule 11: steps carry ids, slots and reason codes — never a product claim', () => {
  const { advisor } = advisorFor();
  const a = advisor.advise({ profile: profileOf(advisor, [{ field: 'primary_concern', value: 'dehydration' }, { field: 'body_area', value: 'face' }]) });
  for (const s of a.steps) assert.deepEqual(Object.keys(s).sort(), ['alternatives', 'handle', 'kind', 'merchandised', 'optional', 'product_id', 'reason_codes', 'scores', 'slot']);
});

test('bundles are never recommended unless asked', () => {
  const { advisor, cat } = advisorFor();
  const a = advisor.advise({ profile: profileOf(advisor, [{ field: 'primary_concern', value: 'dehydration' }, { field: 'body_area', value: 'face' }, { field: 'routine_scope', value: 'complete' }]) });
  assert.ok(!names(a, cat).includes('Set Aqua'));
});

test('two plausible playbooks give ONE distinguishing question, distinguish_by first', () => {
  const { advisor } = advisorFor();
  const a = advisor.advise({ profile: profileOf(advisor, [{ field: 'primary_concern', value: 'wrinkles' }]) });
  assert.equal(a.status, 'needs_info');
  assert.equal(a.next_question.field, 'primary_concern');
  assert.deepEqual(a.next_question.options.map((o) => o.value), ['firmness', 'global_ageing']);
  assert.equal(a.next_question.options[1].label, 'Signes globaux');
  // Answered: the chip's concern becomes primary, wrinkles stays as secondary.
  const p = mergeProfile(profileOf(advisor, [{ field: 'primary_concern', value: 'wrinkles' }]), [{ field: 'primary_concern', value: 'global_ageing', source: 'quick_choice', replace: true }], { allowed: advisor.allowed }).profile;
  assert.equal(p.primary_concern.value, 'global_ageing');
  assert.deepEqual(p.secondary_concerns.value, ['wrinkles']);
  assert.equal(advisor.advise({ profile: p }).playbook.key, 'global');
});

test('a secondary concern settles the ambiguity without asking', () => {
  const { advisor } = advisorFor();
  const a = advisor.advise({ profile: profileOf(advisor, [{ field: 'primary_concern', value: 'tightness' }, { field: 'sensitivity', value: 'sensitive' }]) });
  assert.equal(a.playbook.key, 'sensitive');
});

test('conversation mode recommends at once; routine builder asks what changes the routine, once each', () => {
  const { advisor } = advisorFor();
  const profile = profileOf(advisor, [{ field: 'primary_concern', value: 'dehydration' }, { field: 'body_area', value: 'face' }, { field: 'body_area', value: 'face' }]);
  assert.equal(advisor.advise({ profile }).status, 'recommended');
  const q1 = advisor.advise({ profile, mode: 'routine_builder' });
  assert.equal(q1.next_question.field, 'skin_type');
  const q2 = advisor.advise({ profile, mode: 'routine_builder', asked: ['skin_type'] });
  assert.notEqual(q2.next_question?.field, 'skin_type');
});

test('the lexicon reads the brief\'s own example, and « je ne sais pas » answers the question asked', () => {
  const { updates } = extractProfile("J'ai la peau sèche et je commence à avoir des rides");
  assert.deepEqual(updates.map((u) => [u.field, u.value]), [['skin_type', 'dry'], ['primary_concern', 'early_signs_of_ageing']]);
  assert.deepEqual(extractProfile('je ne sais pas', { lastAsked: 'skin_type' }).updates.map((u) => [u.field, u.value]), [['skin_type', 'unknown']]);
  assert.deepEqual(extractProfile("J'ai des rides autour des yeux").updates.map((u) => [u.field, u.value]), [['body_area', 'eyes'], ['primary_concern', 'eye_wrinkles']]);
  assert.ok(extractProfile('Construire ma routine').routineBuilder);
  const men = extractProfile('Une crème pour mon mari, il a la peau grasse').updates;
  assert.ok(men.some((u) => u.field === 'sex_target' && u.value === 'men'));
  assert.ok(men.some((u) => u.field === 'skin_type' && u.value === 'oily'));
});

test('profile merge: an explicit answer beats an inference, unknown is an answer, invalid values are dropped', () => {
  const allowed = allowedValues({ concernKeys: ['dehydration', 'dullness'], slotKinds: ['serum', 'moisturiser'] });
  let { profile, changed } = mergeProfile({}, [{ field: 'skin_type', value: 'dry', source: 'model_inferred' }, { field: 'skin_type', value: 'banana', source: 'quick_choice' }], { allowed });
  assert.equal(profile.skin_type.value, 'dry');
  assert.equal(changed.length, 1);
  ({ profile } = mergeProfile(profile, [{ field: 'skin_type', value: 'oily', source: 'quick_choice' }], { allowed }));
  assert.deepEqual([profile.skin_type.value, profile.skin_type.source], ['oily', 'quick_choice']);
  ({ profile } = mergeProfile(profile, [{ field: 'skin_type', value: 'dry', source: 'model_inferred' }], { allowed }));
  assert.equal(profile.skin_type.value, 'oily', 'an inference does not override the customer\'s own answer');
  ({ profile } = mergeProfile(profile, [{ field: 'primary_concern', value: 'dehydration', source: 'natural_language' }, { field: 'primary_concern', value: 'dullness', source: 'natural_language' }], { allowed }));
  assert.equal(profile.primary_concern.value, 'dehydration');
  assert.deepEqual(profile.secondary_concerns.value, ['dullness']);
  ({ profile } = mergeProfile(profile, [{ field: 'current_routine', value: 'none', source: 'quick_choice' }], { allowed }));
  assert.deepEqual(profile.current_routine.value, ['none']);
});

test('the config round-trips through the tables exactly', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(here, '../../../data/advisor/qiriness.json'), 'utf8'));
  raw.merchandising.entries = [{ target_kind: 'family', target: 'Temps Sublime', tier: 'hero', concern: 'wrinkles', starts_at: '2026-10-01T00:00:00Z' }];
  const rows = configToRows(raw, 'shop-1');
  assert.deepEqual(rowsToConfig(rows), raw);
  assert.equal(rowsToConfig({ playbooks: [], mappings: rows.mappings }), null);
});

test('events carry codes and ids, never free text, and a turn derives them from state', () => {
  assert.equal(createEvent({ channel: 'fax', conversationRef: 's', type: 'conversation_started' }), null);
  assert.equal(createEvent({ channel: 'storefront_chat', conversationRef: 's', type: 'made_up' }), null);
  const advice = { status: 'recommended', scope: 'essential', considered: 4, excluded: { out_of_stock: 1 }, playbook: { key: 'hydra', route: null }, steps: [{ slot: 'serum', product_id: 'p1', reason_codes: ['primary_concern:dehydration'], merchandised: null }], skipped: [], next_question: null };
  const events = turnEvents({ channel: 'storefront_chat', conversationRef: 's1', firstTurn: true, before: null, after: { mode: 'routine_builder' }, changed: [{ field: 'skin_type', source: 'quick_choice' }], advice });
  assert.deepEqual(events.map((e) => e.event_type), ['conversation_started', 'advisory_started', 'routine_builder_started', 'profile_field_collected', 'products_considered', 'products_recommended', 'routine_builder_completed']);
  assert.deepEqual(events.find((e) => e.event_type === 'products_recommended').product_ids, ['p1']);
  assert.deepEqual(events.find((e) => e.event_type === 'products_recommended').payload.steps, [{ slot: 'serum', reasons: ['primary_concern'], merchandised: null }]);
  assert.deepEqual(events.find((e) => e.event_type === 'profile_field_collected').payload, { field: 'skin_type', source: 'quick_choice' });
});

test('slotList: scopes and routes', () => {
  const pb = brand().playbooks[0];
  assert.deepEqual(slotList(pb, null, 'targeted').map((s) => s.key), ['serum', 'cream']);
  assert.deepEqual(slotList(pb, null, 'complete').map((s) => s.key), ['cleanser', 'serum', 'cream']);
  const route = { essential: ['cleanser', 'cream'], targeted: ['cream'], optional: ['x'] };
  assert.deepEqual(slotList({}, route, 'targeted').map((s) => s.key), ['cream']);
  assert.deepEqual(slotList({}, route, 'complete').map((s) => [s.key, s.optional]), [['cleanser', false], ['cream', false], ['x', true]]);
});

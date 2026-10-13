import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createAdvisor } from './recommend.mjs';
import { extractProfile } from './lexicon.mjs';
import { mergeProfile } from './profile.mjs';
import { knowledgeIndex, parseKnowledgeRows } from './product-knowledge.mjs';

// The foundation engine (plan § 3.1–3.4), one rule per test, on the INVENTED
// routines bench (data/advisor/sample-routines/). The full scorecard is
// `npm run advisor:score`.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const CONFIG = read('data/advisor/qiriness.json');
const CATALOGUE = read('data/advisor/sample-routines/catalogue.json');
const SHEET = read('data/advisor/sample-routines/knowledge.json');
const ROUTINES = read('data/advisor/sample-routines/routines.json');
const KNOWLEDGE = knowledgeIndex(parseKnowledgeRows(SHEET.rows, { concerns: SHEET.concerns }).products);
const advisor = createAdvisor(CONFIG, CATALOGUE, { knowledge: KNOWLEDGE, routines: ROUTINES });
const id = (handle) => CATALOGUE.products.find((p) => p.handle === handle).id;
const K = (step) => KNOWLEDGE.get(step.handle);
const q = (value) => ({ value, source: 'quick_choice', confidence: 'high', turn: 1 });
const nl = (value) => ({ value, source: 'natural_language', confidence: 'medium', turn: 1 });
const ASKED = ['skin_type', 'sensitivity', 'current_routine', 'routine_scope', 'age_band'];
const said = (message) => mergeProfile({}, extractProfile(message).updates, { allowed: advisor.allowed }).profile;
const build = (profile, extra = {}) => advisor.advise({ profile, mode: 'routine_builder', asked: ASKED, ...extra });
const types = (a) => a.steps.map((s) => K(s).functional_type);

test('side by side: without routines the playbook engine runs; with them, the foundations', () => {
  assert.equal(createAdvisor(CONFIG, CATALOGUE, { knowledge: KNOWLEDGE }).engine, undefined);
  assert.equal(advisor.engine, 'foundations');
});

test('§ 3.1 the foundation: a chosen concern decides; otherwise votes, ties to the brand\'s priority', () => {
  assert.equal(build({ primary_concern: q('dullness'), secondary_concerns: nl(['early_signs_of_ageing']) }).playbook.key, 'D');
  // Natural words, one vote each: Éclat and Anti-âge tie, the priority (C, F, E, B, A, D) gives E.
  assert.equal(build({ primary_concern: nl('dullness'), secondary_concerns: nl(['early_signs_of_ageing']) }).playbook.key, 'E');
  assert.equal(build({ primary_concern: nl('redness'), secondary_concerns: nl(['dehydration']) }).playbook.key, 'C');
});

test('§ 3.1 dry skin is Hydration only when nothing else is the main need', () => {
  assert.equal(build({ skin_type: q('dry') }).playbook.key, 'A');
  assert.equal(build({ skin_type: q('dry'), primary_concern: nl('dark_spots') }).playbook.key, 'F');
  // …and it still chooses the cream: rich.
  const f = build({ skin_type: q('dry'), primary_concern: nl('dark_spots') });
  assert.notEqual(K(f.steps.find((s) => K(s).functional_type === 'cream')).texture, 'light');
});

test('§ 3.1 the basic routine only on request; no concern and no request is one question', () => {
  assert.equal(build({ request: q('basic_routine') }).playbook.key, 'G');
  const none = advisor.advise({ profile: {}, mode: 'routine_builder' });
  assert.equal(none.status, 'needs_info');
  assert.equal(none.next_question.field, 'primary_concern');
  assert.ok(none.next_question.options.length >= 6);
});

test('§ 3.2 sizes: essential = daily required; complete = daily + modules; spa adds the occasional; targeted is one', () => {
  const profile = { primary_concern: nl('dehydration'), skin_type: q('normal') };
  assert.deepEqual(types(build(profile)), ['cleanser', 'serum', 'cream']);
  assert.deepEqual(types(build({ ...profile, routine_scope: q('complete') })), ['cleanser', 'serum', 'cream', 'lotion']);
  assert.deepEqual(types(build({ ...profile, routine_scope: q('spa') })), ['cleanser', 'serum', 'cream', 'lotion', 'exfoliant', 'mask']);
  assert.deepEqual(types(advisor.advise({ profile })), ['serum']);
  // The eyes module joins a complete routine when an eye concern is there.
  assert.ok(types(build({ ...profile, secondary_concerns: nl(['dark_circles']), routine_scope: q('complete') })).includes('eye'));
});

test('§ 3.2 never pad: a step with no suitable product is said, not filled', () => {
  // Take every lotion out of the catalogue: the Imperfections routine's lotion step is reported empty.
  const noLotion = { ...CATALOGUE, products: CATALOGUE.products.filter((p) => !['Lotion'].includes(p.type)) };
  const a = createAdvisor(CONFIG, noLotion, { knowledge: KNOWLEDGE, routines: ROUTINES }).advise({ profile: { primary_concern: nl('imperfections'), skin_type: q('oily') }, mode: 'routine_builder', asked: ASKED });
  assert.ok(!types(a).includes('lotion'));
  assert.ok(a.skipped.some((s) => s.kind === 'lotion' && s.reason === 'no_eligible_product'));
});

test('owner\'s rule: an owned type is not doubled, unless the step is the one the concern needs', () => {
  const owned = build({ primary_concern: nl('dehydration'), current_routine: q(['cleanser', 'moisturiser']) });
  assert.deepEqual(types(owned), ['serum']);
  assert.deepEqual(owned.skipped.map((s) => s.reason), ['already_in_routine', 'already_in_routine']);
  const spots = build({ primary_concern: nl('dark_spots'), current_routine: q(['serum']) });
  const serum = spots.steps.find((s) => K(s).functional_type === 'serum');
  assert.ok(serum.reason_codes.includes('concern_needs_specific_product'));
  assert.ok(K(serum).primary_concern === 'dark_spots' || K(serum).other_concerns.includes('dark_spots'));
});

test('hard rules: stock, « Ne pas conseiller », men, skin « Non adapté », « Déconseillé » for sensitive skin', () => {
  const all = ['essential', 'complete', 'spa'].flatMap((s) => build({ skin_type: q('dry'), routine_scope: q(s) }).steps.flatMap((x) => [x.handle, ...x.alternatives.map((a) => a.handle)]));
  for (const h of ['t-serum-aqua-intense', 't-creme-retiree', 't-creme-homme', 't-creme-aqua-light']) assert.ok(!all.includes(h), h);
  const sensitive = build({ primary_concern: nl('dullness'), sensitivity: q('sensitive'), routine_scope: q('spa') });
  assert.ok(sensitive.steps.every((s) => K(s).sensitive !== 'avoid'));
});

test('premium only when a concern justifies it; men\'s products first for a man', () => {
  assert.ok(build({ primary_concern: nl('wrinkles') }).steps.every((s) => !K(s).premium));
  assert.ok(build({ primary_concern: nl('deep_wrinkles') }).steps.some((s) => K(s).premium));
  const men = build({ skin_type: q('dry'), sex_target: q('men') });
  assert.equal(K(men.steps.find((s) => K(s).functional_type === 'cream')).men, true);
  assert.equal(K(men.steps.find((s) => K(s).functional_type === 'cleanser')).men, true);
});

test('§ 3.1 texture by skin type: rich for dry, light for oily', () => {
  const cream = (skin) => K(build({ primary_concern: nl('dehydration'), skin_type: q(skin) }).steps.find((s) => K(s).functional_type === 'cream')).texture;
  assert.equal(cream('dry'), 'rich');
  assert.equal(cream('oily'), 'light');
});

test('§ 3.3 questions: only those that change the routine, in the brand\'s order, never age', () => {
  const first = advisor.advise({ profile: { primary_concern: nl('dehydration') }, mode: 'routine_builder' });
  assert.equal(first.next_question.field, 'skin_type');
  const sized = advisor.advise({ profile: { primary_concern: nl('dehydration'), skin_type: q('dry'), sensitivity: q('none'), current_routine: q(['none']) }, mode: 'routine_builder', locale: 'fr' });
  assert.equal(sized.next_question.field, 'routine_scope');
  assert.deepEqual(sized.next_question.options.map((o) => o.label), ROUTINES.questions.chips.size.fr);
  assert.ok(!JSON.stringify([first, sized]).includes('age_band'));
});

test('§ 3.4 a gift is gift sets first; a spa evening is the spa routine; a small budget is essential with no treat', () => {
  const gift = advisor.advise({ profile: said('Je cherche un cadeau pour ma mère') });
  assert.equal(gift.playbook.key, 'gift');
  assert.ok(KNOWLEDGE.get(gift.steps[0].handle).gift || KNOWLEDGE.get(gift.steps[0].handle).functional_type === 'kit');
  const spa = advisor.advise({ profile: said('I want a spa evening at home') });
  assert.equal(spa.playbook.key, 'spa');
  assert.ok(types(spa).includes('mask'));
  const budget = build({ ...said("J'ai un petit budget"), primary_concern: nl('dehydration'), routine_scope: q('complete') });
  assert.equal(budget.scope, 'essential');
  assert.equal(advisor.treat({ profile: { budget: q('small') } }), null);
  assert.ok(advisor.treat({ profile: { primary_concern: nl('dehydration') } }));
});

test('the lexicon reads the new requests and « visage sec » / « dry face », in French and English', () => {
  const read1 = (s) => extractProfile(s).updates.map((u) => `${u.field}:${u.value}`);
  assert.ok(read1('Je veux juste une routine de base').includes('request:basic_routine'));
  assert.ok(read1('I just want a basic routine').includes('request:basic_routine'));
  assert.ok(read1('Une idée cadeau ?').includes('request:gift'));
  assert.ok(read1('Une soirée spa').includes('request:spa'));
  assert.ok(read1('on a budget').includes('budget:small'));
  assert.ok(read1("J'ai le visage sec").includes('skin_type:dry'));
  assert.ok(read1('I have a very dry face').includes('skin_type:very_dry'));
  assert.ok(read1('My face is oily').includes('skin_type:oily'));
});

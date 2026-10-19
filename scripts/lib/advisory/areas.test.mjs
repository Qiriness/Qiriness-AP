import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildAdvisorKnowledge } from './advisor-knowledge.mjs';
import { extractProfile, mentionsCaution } from './lexicon.mjs';
import { mergeProfile } from './profile.mjs';
import { knowledgeIndex } from './product-knowledge.mjs';
import { createAdvisor } from './recommend.mjs';

// THE OWNER'S NOTES V4 (2026-10-19), engine side, on Qiriness's real sheet with every advised product in
// stock (as day-night.test.mjs): the hands, lips and body get their own products, the eyes their eye
// products, the marks spots leave the spot products. French and English.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const built = buildAdvisorKnowledge({ sheet: read('data/advisor/qiriness-knowledge.json'), settings: read('data/advisor/qiriness-routine-settings.json') });
const CATALOGUE = {
  products: built.products.map((k) => ({ id: k.handle, handle: k.handle, name: k.title ?? k.handle, inStock: true, priceFrom: Number(k.price) || 10, variants: [], collections: [], tags: [] })),
  collections: [],
};
const KNOWLEDGE = knowledgeIndex(built.products);
const advisor = createAdvisor(read('data/advisor/qiriness.json'), CATALOGUE, { knowledge: KNOWLEDGE, routines: built.routines });
const q = (value) => ({ value, source: 'quick_choice', confidence: 'high', turn: 1 });
const said = (message, profile = {}) => mergeProfile(profile, extractProfile(message, { profile }).updates, { allowed: advisor.allowed }).profile;
const advise = (message, extra = {}) => advisor.advise({ profile: said(message), ...extra });
const shown = (a) => a.steps.flatMap((s) => [s.handle, ...s.alternatives.map((x) => x.handle)]);
const areaOf = (handle) => KNOWLEDGE.get(handle).area;

test('the hands, lips, feet and body are read, FR and EN; « main » alone is not (« my main concern »)', () => {
  const area = (m) => extractProfile(m).updates.find((u) => u.field === 'body_area')?.value ?? null;
  assert.equal(area("J'ai les mains très sèches à force de me les laver"), 'hands');
  assert.equal(area("J'ai des taches pigmentaires sur le dos des mains"), 'hands');
  assert.equal(area('Mes lèvres sont gercées'), 'lips');
  assert.equal(area("J'ai la peau rugueuse sur les coudes et les genoux"), 'body');
  assert.equal(area('My hands are very dry from washing them'), 'hands');
  assert.equal(area('I have chapped lips'), 'lips');
  assert.equal(area('Rough skin on my elbows and knees'), 'body');
  assert.equal(area('My main concern is wrinkles'), null);
  assert.equal(area('maintenant j’ai des taches'), null);
  // Dry there is a dryness concern, not a skin type of the face.
  for (const m of ["J'ai les mains très sèches", 'Mes lèvres sont gercées', 'My hands are very dry', 'I have chapped lips']) {
    assert.equal(extractProfile(m).updates.find((u) => u.field === 'primary_concern')?.value, 'dryness', m);
  }
});

test('dry hands get the hand cream first, then the hand mask; never the face cream (owner: « should prioritise a hand cream »)', () => {
  for (const message of ["J'ai les mains très sèches à force de me les laver. Quel produit utiliser ?", 'My hands are very dry from washing them. What should I use?']) {
    const a = advise(message);
    assert.equal(a.status, 'recommended', message);
    assert.equal(a.area, 'hands');
    assert.equal(a.steps[0].handle, 'creme-mains-hydratante-caresse-mains-velours', message);
    assert.ok(shown(a).every((h) => areaOf(h) === 'hands'), shown(a).join());
    assert.ok(a.steps[0].top_choices);
  }
});

test('dry lips get the lip balm; the body its creams and milk, a shower oil last, never a kit or a deodorant', () => {
  assert.equal(advise("J'ai les lèvres sèches et gercées").steps[0].handle, 'baume-levres-hydratant-lip-beauty');
  for (const message of ["J'ai la peau du corps très sèche, notamment après la douche. Que me conseillez-vous ?", 'The skin on my body is very dry, especially after showering.', "J'ai la peau rugueuse sur les coudes et les genoux. Quel rituel pourrait aider ?"]) {
    const a = advise(message);
    assert.equal(a.area, 'body', message);
    assert.deepEqual(shown(a), ['creme-corps-body-wrap-hydra-relax', 'lait-qi-soin-corps-ultra-revitalisant-hydratation-eclat', 'huile-de-douche'], message);
  }
});

test('nothing for the need on that area is said, never padded: spots on the hands get no face product, and no fallback', () => {
  const a = advise("J'ai des taches pigmentaires sur le dos des mains. Les soins Qiriness peuvent-ils les atténuer ?");
  assert.equal(a.status, 'no_match');
  assert.equal(a.area, 'hands');
  assert.deepEqual(a.steps, []);
});

test('no hand product for dryness: the face cream, marked `area_fallback` (owner: « the falling back to that cream is fine »)', () => {
  const noHands = { products: CATALOGUE.products.map((p) => (areaOf(p.handle) === 'hands' ? { ...p, inStock: false } : p)), collections: [] };
  const fallback = createAdvisor(read('data/advisor/qiriness.json'), noHands, { knowledge: KNOWLEDGE, routines: built.routines });
  const a = fallback.advise({ profile: said("J'ai les mains très sèches") });
  assert.equal(a.status, 'recommended');
  assert.deepEqual(a.area_fallback, { from: 'hands', to: 'face' });
  assert.equal(areaOf(a.steps[0].handle), 'face');
  // Spots on the hands are not a fallback need.
  assert.equal(fallback.advise({ profile: said("J'ai des taches sur les mains") }).status, 'no_match');
});

test('the hands, lips or body with no concern: no face buttons, the model asks; the builder still builds the face routine', () => {
  const open = advise('Est-ce que je peux utiliser ma crème visage sur mon cou, mon décolleté ou mes mains ?');
  assert.equal(open.status, 'needs_info');
  assert.equal(open.next_question, null);
  const builder = advisor.advise({ profile: { ...said("J'ai la peau du corps très sèche"), primary_concern: q('dehydration') }, mode: 'routine_builder', asked: [] });
  assert.equal(builder.status, 'needs_info');
  assert.equal(builder.reason, 'routine_builder');
  assert.notEqual(builder.next_question.field, 'primary_concern');
});

test('a « rituel » for the elbows or the body does not open the face builder; one for the face still does', () => {
  assert.equal(extractProfile("Quel rituel pour la peau rugueuse de mes coudes ? Je veux un rituel").routineBuilder, false);
  assert.equal(extractProfile('I want a ritual for my dry hands').routineBuilder, false);
  assert.equal(extractProfile('Je veux une routine pour le visage').routineBuilder, true);
});

test('« contour des yeux » with no concern: eye buttons, FR and EN; « Rides du contour des yeux » gives the eye creams', () => {
  const fr = advise('Quels produits Qiriness sont les plus adaptés au contour des yeux ?');
  assert.deepEqual(fr.next_question.options.map((o) => [o.label, o.value]), [['Cernes', 'dark_circles'], ['Poches', 'puffiness'], ['Rides du contour des yeux', 'eye_wrinkles'], ['Déshydratation', 'dehydration']]);
  const en = advise('Which Qiriness products are best for the eye area?', { locale: 'en' });
  assert.deepEqual(en.next_question.options.map((o) => o.label), ['Dark circles', 'Puffiness', 'Wrinkles around the eyes', 'Dehydration']);
  const wrinkles = advisor.advise({ profile: { ...said('le contour des yeux'), primary_concern: q('eye_wrinkles') } });
  assert.ok(shown(wrinkles).length && shown(wrinkles).every((h) => areaOf(h) === 'eyes'), shown(wrinkles).join());
  // The face routine builder keeps the face's buttons.
  assert.equal(advisor.advise({ profile: said('le contour des yeux'), mode: 'routine_builder' }).next_question.options[0].value, 'dehydration');
});

test('a face concern asked about the eyes gets eye products for it; none is said, never the face\'s; a guessed one asks', () => {
  const dry = advisor.advise({ profile: { ...said('le contour des yeux'), primary_concern: q('dehydration') } });
  assert.equal(dry.area, 'eyes');
  assert.ok(shown(dry).every((h) => areaOf(h) === 'eyes'), shown(dry).join());
  const spots = advisor.advise({ profile: { ...said('le contour des yeux'), primary_concern: q('dark_spots') } });
  assert.equal(spots.status, 'no_match');
  assert.deepEqual(spots.steps, []);
  // The model reader's guess ("best for the eye area" → dehydration): the eye buttons instead.
  const guessed = advisor.advise({ profile: { ...said('Which products are best for the eye area?'), primary_concern: { value: 'dehydration', source: 'model_inferred', confidence: 'medium', turn: 1 } } });
  assert.equal(guessed.next_question.options[0].value, 'dark_circles');
});

test('puffiness under the eyes: the roller, FR and EN', () => {
  assert.equal(advise("J'ai les poches sous les yeux très visibles le matin. Quel soin me conseillez-vous ?").steps[0].handle, 'roller-yeux-rafraichissant-et-decongestionnant');
  assert.equal(advise('I have very puffy eyes in the morning').steps[0].handle, 'roller-yeux-rafraichissant-et-decongestionnant');
});

test('the marks old spots leave are dark spots (the Éclat Parfait products); « boutons » alone stays blemishes', () => {
  for (const message of ["J'ai des marques laissées par d'anciens boutons. Comment améliorer leur apparence ?", "J'ai des cicatrices d'acné", 'I have marks left by old spots', 'acne scars']) {
    const a = advise(message);
    assert.equal(said(message).primary_concern.value, 'dark_spots', message);
    assert.ok(shown(a).some((h) => /eclat-parfait/.test(h)), `${message}: ${shown(a).join()}`);
  }
  assert.equal(said("J'ai des boutons sur le menton").primary_concern.value, 'imperfections');
  assert.equal(said('I have spots on my chin').primary_concern.value, 'imperfections');
});

test('« ma crème » is a cream asked for, as « mon sérum » is a serum', () => {
  assert.equal(said('je cherche une alternative à ma crème').desired_care_type.value, 'moisturiser');
});

test('a type asked for while the concern is still open: examples of that type, one per range first', () => {
  const a = advisor.advise({ profile: said('je cherche une crème'), asked: ['primary_concern'] });
  assert.equal(a.playbook.key, 'type_examples');
  const handles = shown(a);
  assert.equal(handles.length, 3);
  assert.ok(handles.every((h) => KNOWLEDGE.get(h).functional_type === 'cream' && KNOWLEDGE.get(h).range), handles.join());
  assert.equal(new Set(handles.map((h) => KNOWLEDGE.get(h).range)).size, 3);
  // Not asked yet: the concern question, as before.
  assert.equal(advisor.advise({ profile: said('je cherche une crème') }).next_question.field, 'primary_concern');
});

test('a medical situation, a treatment, an allergy or a reaction is read, FR and EN; a product request or redness is not', () => {
  for (const m of ["Je prends un traitement dermatologique contre l'acné", "J'ai un grain de beauté qui a changé de couleur", 'Je suis allergique au parfum', 'ma peau brûle avec des plaques rouges', 'Je suis enceinte', "I'm on an acne treatment", 'I have a mole that changed', "I'm allergic to fragrance", 'red patches and burning', 'I am pregnant']) assert.ok(mentionsCaution(m), m);
  for (const m of ['Avez-vous un traitement anti-acné ?', "J'ai des rougeurs sur les joues", 'peau sensible et réactive', 'Do you have an acne cream?', 'I have redness on my cheeks', 'un masque de grossesse']) assert.ok(!mentionsCaution(m), m);
});

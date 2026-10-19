import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildAdvisorKnowledge } from './advisor-knowledge.mjs';
import { extractProfile } from './lexicon.mjs';
import { mergeProfile } from './profile.mjs';
import { knowledgeIndex } from './product-knowledge.mjs';
import { createAdvisor } from './recommend.mjs';

// THE DAY / NIGHT ROUTINE (owner, 2026-10-16) on Qiriness's real sheet, every
// advised product in stock at its sheet price: what the spreadsheet decides,
// whatever the shop's stock is today.
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
const ALL = ['primary_concern', 'skin_type', 'age_band', 'routine_time'];
const build = (profile, extra = {}) => advisor.advise({ profile, mode: 'routine_builder', asked: ALL, ...extra });
const anti = (skin, age, time, more = {}) => build({ primary_concern: q('global_signs_of_ageing'), skin_type: q(skin), age_band: q(age), routine_time: q(time), ...more });
const handles = (a, part) => a.steps.filter((s) => !part || s.part === part).map((s) => s.handle);
const said = (message, profile = {}) => mergeProfile(profile, extractProfile(message).updates, { allowed: advisor.allowed }).profile;

test('the questions: main concern, skin type (sensitive among them), age, then day / night / both', () => {
  const ask = (profile, asked) => advisor.advise({ profile, mode: 'routine_builder', asked }).next_question;
  const first = ask({}, []);
  assert.equal(first.field, 'primary_concern');
  // One button per main concern, labelled and valued by the settings (owner, 2026-10-17).
  assert.deepEqual(first.options.map((o) => [o.label, o.value]), [['Déshydratation', 'dehydration'], ['Imperfections', 'imperfections'], ['Taches et teint terne', 'dark_spots+dullness'], ['Rides', 'wrinkles'], ['Premières rides', 'early_signs_of_ageing'], ['Cernes et poches', 'dark_circles']]);
  assert.equal(first.text, 'Quelle est votre préoccupation principale ?');
  const skin = ask({ primary_concern: q('global_signs_of_ageing') }, ['primary_concern']);
  assert.equal(skin.field, 'skin_type');
  // No « Je ne sais pas » (owner, 2026-10-17).
  assert.deepEqual(skin.options.map((o) => o.value), ['dry', 'normal', 'combination', 'oily', 'sensitive']);
  assert.equal(skin.options.find((o) => o.value === 'sensitive').label, 'Sensible');
  const age = ask({ primary_concern: q('global_signs_of_ageing'), skin_type: q('dry') }, ['primary_concern', 'skin_type']);
  assert.equal(age.field, 'age_band');
  assert.deepEqual(age.options.map((o) => o.label), ['Moins de 25 ans', '25 à 34 ans', '35 à 44 ans', '45 ans et plus']);
  const time = ask({ primary_concern: q('global_signs_of_ageing'), skin_type: q('dry'), age_band: q('35_44') }, ['primary_concern', 'skin_type', 'age_band']);
  assert.equal(time.field, 'routine_time');
  assert.deepEqual(time.options.map((o) => o.label), ['Routine du jour', 'Routine de nuit', 'Jour et nuit']);
  // No price on the moments (owner, 2026-10-17: the cards show them).
  assert.ok(time.options.every((o) => o.total === undefined));
});

test('…in English too; and the age is asked for every concern, hydration too (owner, 2026-10-17: kept for statistics)', () => {
  const en = advisor.advise({ profile: { primary_concern: q('wrinkles'), skin_type: q('dry') }, mode: 'routine_builder', asked: ['primary_concern', 'skin_type'], locale: 'en' }).next_question;
  assert.deepEqual(en.options.map((o) => o.label), ['Under 25', '25 to 34', '35 to 44', '45 and over']);
  assert.equal(en.text, 'What is your age range?');
  const hydration = advisor.advise({ profile: { primary_concern: q('dehydration'), skin_type: q('dry') }, mode: 'routine_builder', asked: ['primary_concern', 'skin_type'], locale: 'en' }).next_question;
  assert.equal(hydration.field, 'age_band');
  const time = advisor.advise({ profile: { primary_concern: q('dehydration'), skin_type: q('dry'), age_band: q('25_34') }, mode: 'routine_builder', asked: ['primary_concern', 'skin_type', 'age_band'], locale: 'en' }).next_question;
  assert.deepEqual(time.options.map((o) => o.label), ['Day routine', 'Night routine', 'Day and night']);
});

test('an age said in words answers the age question, in French and English; « routine du soir » the moment', () => {
  const fr = said("J'ai 32 ans et des rides, je voudrais une routine du soir");
  assert.equal(fr.age.value, '32');
  assert.equal(fr.routine_time.value, 'night');
  const next = advisor.advise({ profile: { ...fr, skin_type: q('dry') }, mode: 'routine_builder', asked: ['primary_concern', 'skin_type'] });
  assert.equal(next.status, 'recommended');
  assert.equal(next.playbook.preferred_family, 'Temps Sublime');
  const en = said("I'm 52, I have wrinkles and want a morning and evening routine");
  assert.equal(en.routine_time.value, 'both');
  assert.equal(advisor.advise({ profile: { ...en, skin_type: q('normal') }, mode: 'routine_builder', asked: ['primary_concern', 'skin_type'] }).playbook.preferred_family, 'Exception');
  assert.equal(said('a night routine for my dry skin').routine_time.value, 'night');
});

test('the day routine: four products, a cleanser or lotion, the serum, the eye care and the cream of one range', () => {
  const a = anti('dry', '35_44', 'day');
  assert.equal(a.status, 'recommended');
  assert.deepEqual(handles(a), [
    'lotion-hydratante-nettoyante-peaux-seches',
    'serum-anti-age-liftant-hyaluronique-retinol-eclat-elixir-temps-sublime',
    'creme-contour-yeux-anti-age-levres-acide-hyaluronique',
    'creme-hydratante-riche-anti-rides-temps-sublime',
  ]);
  assert.ok(a.steps[1].reason_codes.includes('age_range:35_44'));
  assert.ok(a.steps[3].reason_codes.includes('texture_match:rich'));
});

test('the age chooses the anti-age range: Active Énergie under 25, Temps Sublime 25–44, Exception from 45 with its eye cream', () => {
  const range = (age) => [...new Set(anti('normal', age, 'day').steps.slice(1).map((s) => KNOWLEDGE.get(s.handle).range))];
  assert.deepEqual(range('under_25'), ['Active Énergie']);
  assert.deepEqual(range('25_34'), ['Temps Sublime']);
  assert.deepEqual(range('45_plus'), ['Exception']);
  assert.equal(anti('normal', '45_plus', 'day').steps[2].handle, 'regard-dexception');
  // « Premières rides » (fine lines) follows the age as well: at 45, Exception.
  const fine = build({ primary_concern: q('early_signs_of_ageing'), skin_type: q('normal'), age_band: q('45_plus'), routine_time: q('day') });
  assert.equal(fine.steps[1].handle, 'serum-anti-age-elixir-dexception');
});

test('a range with no eye care of its own: the eye serum with no range', () => {
  const a = build({ primary_concern: q('dehydration'), skin_type: q('dry'), routine_time: q('day') });
  assert.equal(a.playbook.preferred_family, 'Source d’Eau');
  assert.equal(a.steps[1].handle, 'serum-acide-hyaluronique-elixir-source-deau');
  assert.equal(a.steps[2].handle, 'serum-anti-age-elixir-regard-eclat');
  assert.equal(a.steps[3].handle, 'creme-hydratante-peau-seche-caresse-source-deau-riche');
});

test('the night routine: a make-up remover, a lotion, the eye care and the range\'s night cream', () => {
  const a = anti('dry', '35_44', 'night');
  assert.deepEqual(a.steps.map((s) => KNOWLEDGE.get(s.handle).functional_type), ['makeup_remover', 'lotion', 'cream', 'cream']);
  assert.equal(a.steps[0].handle, 'lait-demaquillant-amande-douce');
  assert.equal(a.steps[3].handle, 'creme-nuit-anti-age-caresse-temps-sublime');
  assert.ok(a.steps[3].reason_codes.includes('made_for_time:night'));
  // The eye make-up remover is for the eyes: never the night routine's make-up remover.
  assert.ok(!handles(a).includes('demaquillant-yeux-biphase-express'));
});

test('day and night: the night adds only what the day does not have', () => {
  const ts = anti('dry', '35_44', 'both');
  assert.deepEqual(handles(ts, 'night'), ['lait-demaquillant-amande-douce', 'creme-nuit-anti-age-caresse-temps-sublime']);
  assert.deepEqual(ts.skipped.filter((s) => s.reason === 'also_in_day_routine').map((s) => s.handle), ['lotion-hydratante-nettoyante-peaux-seches', 'creme-contour-yeux-anti-age-levres-acide-hyaluronique']);
  // Exception has no night cream: its cream morning and evening, the day's lotion too; the night adds the make-up remover.
  const ex = anti('normal', '45_plus', 'both');
  assert.equal(handles(ex).length, 5);
  assert.ok(ex.skipped.some((s) => s.handle === 'creme-anti-age-caresse-dexception' && s.reason === 'also_in_day_routine'));
  assert.equal(new Set(handles(ex)).size, handles(ex).length, 'never the same product twice');
});

test('never outside its moment: a night cream is not a day cream, a morning cream not a night cream', () => {
  for (const time of ['day', 'night']) {
    for (const skin of ['dry', 'normal', 'combination', 'oily', 'sensitive']) {
      for (const concern of ['dehydration', 'imperfections', 'dullness', 'wrinkles']) {
        const a = build({ primary_concern: q(concern), skin_type: q(skin), age_band: q('35_44'), routine_time: q(time) });
        for (const s of a.steps) assert.notEqual(KNOWLEDGE.get(s.handle).time_of_day, time === 'day' ? 'evening' : 'morning', `${concern} ${skin} ${time}: ${s.handle}`);
        assert.ok(a.steps.every((s) => !KNOWLEDGE.get(s.handle).men), 'never a men\'s product unless asked');
      }
    }
  }
});

test('a sensitive skin: the gentle cleanser, never a « Déconseillé » product', () => {
  const a = build({ primary_concern: q('dehydration'), skin_type: q('sensitive'), routine_time: q('both') });
  assert.equal(a.steps[0].handle, 'nettoyant-visage-doux');
  assert.ok(a.steps.every((s) => KNOWLEDGE.get(s.handle).sensitive !== 'avoid'));
  assert.ok(a.steps[0].reason_codes.includes('sensitive_skin_match'));
});

test('cleanser or lotion: the skin type, then the concern; a tie goes to the lotion', () => {
  // Combination skin: the mixed-skin cleanser is « Idéal », the lotions « Adapté ».
  assert.equal(build({ primary_concern: q('dehydration'), skin_type: q('combination'), routine_time: q('day') }).steps[0].handle, 'gel-nettoyant-purifiant-peaux-mixtes');
  // Dry skin: the gentle cleanser and the dry-skin lotion are both « Idéal »; the lotion treats dehydration.
  assert.equal(build({ primary_concern: q('dehydration'), skin_type: q('dry'), routine_time: q('day') }).steps[0].handle, 'lotion-hydratante-nettoyante-peaux-seches');
  // Oily skin and blemishes: the purifying lotion and the purifying cleanser tie; the lotion.
  assert.equal(build({ primary_concern: q('imperfections'), skin_type: q('oily'), routine_time: q('day') }).steps[0].handle, 'lotion-tonique-purifiante-matifiante-nettoyante');
});

test('a step whose product must treat the need stays empty rather than padded: no serum treats blemishes', () => {
  const a = build({ primary_concern: q('imperfections'), skin_type: q('oily'), routine_time: q('day') });
  assert.equal(a.steps.length, 3);
  assert.deepEqual(a.skipped.map((s) => [s.slot, s.reason]), [['day_2', 'no_eligible_product']]);
});

test('outside the builder, one product for one need still: the serum for wrinkles, the lotion for blemishes', () => {
  const one = (concern) => advisor.advise({ profile: { primary_concern: q(concern) }, mode: 'conversation' });
  assert.equal(KNOWLEDGE.get(one('wrinkles').steps[0].handle).functional_type, 'serum');
  assert.equal(one('wrinkles').scope, 'targeted');
  assert.equal(KNOWLEDGE.get(one('imperfections').steps[0].handle).functional_type, 'lotion');
  // The eyes alone: an eye product, the eye serums and creams among them.
  const eyes = advisor.advise({ profile: { primary_concern: q('dark_circles') }, mode: 'conversation' });
  assert.equal(KNOWLEDGE.get(eyes.steps[0].handle).area, 'eyes');
});

test('a budget ceiling trims the routine, the serum last', () => {
  const a = anti('dry', '35_44', 'day', { budget_max: q('120') });
  assert.ok(a.total_price <= 120);
  assert.ok(a.steps.some((s) => KNOWLEDGE.get(s.handle).functional_type === 'serum'));
});

// THE EYE ROUTINE (owner, 2026-10-17): its own steps, a fixed product each but
// the cream, the range's eye cream when it treats one of their concerns, else
// « Caresse Regard Énergie ».
const eyes = (eye, age, time) => build({ primary_concern: q('dark_circles'), eye_concern: q(eye), age_band: q(age), routine_time: q(time) });
const STANDARD = 'contour-des-yeux-caresse-regard-energie';

test('the eye routine: the day is the Éclat Parfait lotion, the gold patches, the eye serum and the eye cream', () => {
  const a = eyes('eye_wrinkles', '25_34', 'day');
  assert.equal(a.playbook.key, 'Y');
  assert.deepEqual(handles(a), ['lotion-tonique-hydratante-eclat-parfait', 'patchs-yeux-clat-anti-age-regard-or-60-patchs', 'serum-anti-age-elixir-regard-eclat', 'creme-contour-yeux-anti-age-levres-acide-hyaluronique']);
  assert.deepEqual(a.steps.slice(0, 3).map((s) => s.reason_codes), [['step_product'], ['step_product'], ['step_product']]);
  // The night: the eye make-up remover first.
  assert.deepEqual(handles(eyes('eye_wrinkles', '25_34', 'night')).slice(0, 2), ['demaquillant-yeux-biphase-express', 'lotion-tonique-hydratante-eclat-parfait']);
});

test('the eye cream: the age range’s when it treats one of their concerns, else the standard one', () => {
  const cream = (eye, age) => handles(eyes(eye, age, 'day'))[3];
  assert.equal(cream('eye_wrinkles', '45_plus'), 'regard-dexception');
  assert.equal(cream('dehydration', '45_plus'), 'regard-dexception');
  // Temps Sublime's eye cream treats wrinkles only; no eye cream treats dark spots.
  assert.equal(cream('dehydration', '25_34'), STANDARD);
  assert.equal(cream('dark_spots', '45_plus'), STANDARD);
  assert.equal(cream('dark_spots', 'under_25'), STANDARD);
  assert.deepEqual(eyes('dark_spots', '45_plus', 'day').steps[3].reason_codes, ['step_fallback']);
});

test('the eye routine asks the other eye concern instead of the skin type, every question asked', () => {
  const ask = (profile, asked) => advisor.advise({ profile, mode: 'routine_builder', asked }).next_question?.field ?? null;
  assert.equal(ask({ primary_concern: q('dark_circles') }, ['primary_concern']), 'eye_concern');
  assert.equal(ask({ primary_concern: q('dark_circles'), eye_concern: q('dark_spots') }, ['primary_concern', 'eye_concern']), 'age_band');
  assert.equal(ask({ primary_concern: q('dark_circles'), eye_concern: q('dark_spots'), age_band: q('25_34') }, ['primary_concern', 'eye_concern', 'age_band']), 'routine_time');
  // One of three, no « none » (owner, 2026-10-17).
  assert.deepEqual(advisor.advise({ profile: { primary_concern: q('dark_circles') }, mode: 'routine_builder', asked: ['primary_concern'] }).next_question.options.map((o) => o.value), ['eye_wrinkles', 'dehydration', 'dark_spots']);
});

test('outside the builder, « mes cernes » is still one eye product, not a routine', () => {
  const one = advisor.advise({ profile: said("J'ai des cernes"), mode: 'conversation', asked: [] });
  assert.equal(one.steps.length, 1);
  assert.equal(KNOWLEDGE.get(one.steps[0].handle).area, 'eyes');
});

// THE TREAT AND THE STAGES (owner, 2026-10-17): « this also needs to be adapted to the concerns and
// type of skin »; each step named by its ritual stage.
test('the treat after a routine treats one of their concerns and suits their skin; none fits, none', () => {
  const treatOf = (profile) => advisor.treat({ profile });
  const k = (t) => (t ? KNOWLEDGE.get(t.handle) : null);
  const concernsOf = (x) => [x.primary_concern, ...x.other_concerns];
  // Anti-age, dry skin: never the anti-blemish patch the first test showed.
  const antiAge = treatOf({ primary_concern: q('wrinkles'), skin_type: q('dry') });
  assert.notEqual(antiAge?.handle, 'patch-anti-bouton-invisible-flash-patch®');
  if (antiAge) {
    assert.ok(concernsOf(k(antiAge)).includes('wrinkles'));
    assert.notEqual(k(antiAge).skin?.dry, 'unsuitable');
  }
  const blemish = treatOf({ primary_concern: q('imperfections'), skin_type: q('oily') });
  assert.ok(blemish && concernsOf(k(blemish)).includes('blemishes'));
  // The eye routine's other eye concern counts.
  const eyesTreat = treatOf({ primary_concern: q('dark_circles'), eye_concern: q('eye_wrinkles') });
  if (eyesTreat) {
    assert.ok(concernsOf(k(eyesTreat)).some((c) => ['dark_circles', 'puffiness', 'eye_wrinkles'].includes(c)));
    assert.equal(k(eyesTreat).area, 'eyes');
  }
  // Never a body treat after a face routine.
  const hydration = treatOf({ primary_concern: q('dehydration'), skin_type: q('combination') });
  assert.ok(hydration && ['face', 'eyes'].includes(k(hydration).area ?? 'face'));
});

test('each step carries its ritual stage from the Products tab', () => {
  const a = anti('dry', '35_44', 'day');
  assert.deepEqual(a.steps.map((s) => s.stage), a.steps.map((s) => KNOWLEDGE.get(s.handle).ritual_stage ?? undefined));
  assert.equal(a.steps[0].stage, 'prepare');
});

// BOTH MOMENTS ON THE CARDS (owner, 2026-10-18): the routine they chose, and the other moment with
// what they already have marked, so they see the night routine their day products already make.
test('a day routine carries the night too: its shared steps marked, the rest to complete it', () => {
  const a = anti('dry', '35_44', 'day');
  const m = a.moments;
  assert.equal(m.chosen, 'day');
  assert.deepEqual(m.day.map((s) => s.handle), handles(a));
  assert.ok(m.night.length >= 2);
  const shared = m.night.filter((s) => s.also_in === 'day');
  const missing = m.night.filter((s) => !s.also_in);
  assert.ok(shared.length >= 1, 'the cleanser / lotion / serum are already theirs');
  assert.ok(missing.length >= 1, 'a night product completes it');
  assert.ok(shared.every((s) => handles(a).includes(s.handle)));
  assert.ok(missing.every((s) => !handles(a).includes(s.handle)));
  // The night as a « jour et nuit » build has it, step for step.
  const both = anti('dry', '35_44', 'both');
  assert.deepEqual(m.night.map((s) => s.handle), both.moments.night.map((s) => s.handle));
});

test('a night routine carries the day; « jour et nuit » shows both, the evening with what the morning has', () => {
  const night = anti('combination', '25_34', 'night');
  assert.equal(night.moments.chosen, 'night');
  assert.deepEqual(night.moments.night.map((s) => s.handle), handles(night));
  assert.ok(night.moments.day.length >= 2);
  const both = anti('combination', '25_34', 'both');
  assert.equal(both.moments.chosen, 'both');
  assert.deepEqual(both.moments.day.map((s) => s.handle), handles(both, 'day'));
  // The evening: its own products and, put back, the ones the morning already has.
  assert.ok(both.moments.night.length > handles(both, 'night').length);
  assert.ok(both.moments.night.filter((s) => s.also_in === 'day').every((s) => handles(both, 'day').includes(s.handle)));
  const order = both.moments.night.map((s) => Number(s.slot.split('_').pop()));
  assert.deepEqual(order, [...order].sort((x, y) => x - y));
});

test('the eye routine has both moments too; outside the builder, none', () => {
  const eyes = build({ primary_concern: q('dark_circles'), eye_concern: q('eye_wrinkles'), age_band: q('35_44'), routine_time: q('day') }, { asked: ['primary_concern', 'eye_concern', 'age_band', 'routine_time'] });
  assert.equal(eyes.moments.chosen, 'day');
  assert.ok(eyes.moments.night.some((s) => s.handle === 'demaquillant-yeux-biphase-express' && !s.also_in));
  assert.ok(eyes.moments.night.some((s) => s.handle === 'serum-anti-age-elixir-regard-eclat' && s.also_in === 'day'));
  const asked = advisor.advise({ profile: { primary_concern: q('wrinkles') }, mode: 'conversation' });
  assert.equal(asked.moments, undefined);
});

test('the « petit plaisir » is a mask, a sheet mask or a kit only (owner, 2026-10-18)', () => {
  assert.deepEqual(built.routines.treats.types, ['mask', 'sheet_mask', 'kit']);
  const typeOf = (handle) => KNOWLEDGE.get ? KNOWLEDGE.get(handle)?.functional_type : built.products.find((k) => k.handle === handle)?.functional_type;
  let offered = 0;
  for (const concern of ['dehydration', 'imperfections', 'dark_spots', 'dullness', 'wrinkles', 'early_signs_of_ageing', 'dark_circles', 'blemishes', 'reactivity']) {
    for (const skin of [null, 'dry', 'normal', 'combination', 'oily']) {
      const t = advisor.treat({ profile: { primary_concern: q(concern), ...(skin ? { skin_type: q(skin) } : {}) } });
      if (!t) continue;
      offered += 1;
      assert.ok(['mask', 'sheet_mask', 'kit'].includes(typeOf(t.handle)), `${concern} ${skin}: ${t.handle}`);
    }
  }
  assert.ok(offered > 10);
  // The patches, the gua sha, the sauna and the bath stones are not, whatever the sheet's column says.
  const exclude = built.products.filter((k) => ['mask', 'sheet_mask', 'kit'].includes(k.functional_type)).map((k) => k.handle);
  assert.equal(advisor.treat({ profile: { primary_concern: q('imperfections'), skin_type: q('oily') }, exclude }), null);
});

test('one product for a need: the concern first, the skin type only ranks (owner, 2026-10-18)', () => {
  const misses = [];
  for (const concern of ['wrinkles', 'dehydration', 'imperfections', 'dark_spots', 'dullness', 'early_signs_of_ageing', 'loss_of_firmness', 'redness']) {
    for (const skin of ['dry', 'normal', 'combination', 'oily']) {
      for (const desired of [null, 'serum', 'cream']) {
        const profile = { primary_concern: q(concern), age_band: q('35_44'), ...(desired ? { desired_care_type: q(desired) } : {}) };
        const anySkin = advisor.advise({ profile, mode: 'conversation' });
        const a = advisor.advise({ profile: { ...profile, skin_type: q(skin) }, mode: 'conversation' });
        // Whenever a product answers the need, their skin type never leaves them with none.
        if (anySkin.status === 'recommended' && a.status !== 'recommended') { misses.push(`${concern} ${skin} ${desired}: ${a.reason}`); continue; }
      }
    }
  }
  assert.deepEqual(misses, []);
  // Nothing for the need made for their skin type (every serum marked « Non adapté » to oily skin):
  // still a serum for the wrinkles, marked, never « nothing suits your skin ».
  const unsuited = built.products.map((k) => (k.functional_type === 'serum' ? { ...k, skin: { ...k.skin, oily: 'unsuitable' } } : k));
  const strict = createAdvisor(read('data/advisor/qiriness.json'), CATALOGUE, { knowledge: knowledgeIndex(unsuited), routines: built.routines });
  const serum = strict.advise({ profile: { primary_concern: q('wrinkles'), skin_type: q('oily'), age_band: q('35_44'), desired_care_type: q('serum') }, mode: 'conversation' });
  assert.equal(serum.status, 'recommended');
  assert.ok(serum.steps[0].reason_codes.includes('skin_type_mismatch:oily'));
  // A routine keeps the skin type hard: no unsuited serum in it.
  const routine = strict.advise({ profile: { primary_concern: q('wrinkles'), skin_type: q('oily'), age_band: q('35_44'), routine_time: q('day') }, mode: 'routine_builder', asked: ALL });
  assert.ok(!routine.steps.some((x) => x.type === 'serum'));
  // Wrinkles, oily skin, 35–44: a Temps Sublime product, not « nothing suits your skin ».
  const w = advisor.advise({ profile: { primary_concern: q('wrinkles'), skin_type: q('oily'), age_band: q('35_44') }, mode: 'conversation' });
  assert.equal(w.status, 'recommended');
  assert.match(w.steps[0].handle, /temps-sublime/);
});

test('« je cherche un produit pour les rides » after another concern: wrinkles is the main concern, the old type dropped', async () => {
  const { createAdvisorTurn } = await import('../storefront-chat/advisor-tools.mjs');
  const state = { profile: { primary_concern: q('dehydration'), skin_type: q('oily'), age_band: q('35_44'), desired_care_type: { value: 'serum', source: 'natural_language', confidence: 'medium', turn: 2 } }, mode: 'conversation', asked: ['primary_concern', 'skin_type', 'age_band'], last_question: null, last_advice: null };
  for (const message of ['je cherche un produit pour les ride', 'ma preocupation son mes rides', 'My main concern is wrinkles', "I'm looking for something for wrinkles"]) {
    const turn = createAdvisorTurn({ advisor, state, message, catalogue: CATALOGUE, money: (n) => `${n} €` });
    const a = turn.opening();
    assert.equal(turn.profile.primary_concern.value, 'wrinkles', message);
    assert.equal(turn.profile.desired_care_type, undefined, message);
    assert.equal(a.status, 'recommended', message);
    assert.match(a.steps[0].handle, /temps-sublime/, message);
  }
  // A type said with it stays: « un sérum pour les rides ».
  const serum = createAdvisorTurn({ advisor, state, message: 'je cherche un sérum pour les rides', catalogue: CATALOGUE, money: (n) => `${n} €` });
  serum.opening();
  assert.equal(serum.profile.desired_care_type.value, 'serum');
  // « j'ai aussi des rides »: another concern, the main one kept.
  const also = createAdvisorTurn({ advisor, state, message: "j'ai aussi des rides", catalogue: CATALOGUE, money: (n) => `${n} €` });
  assert.equal(also.profile.primary_concern.value, 'dehydration');
});

test('switching concern later: asked as a question, after an eye concern, then the type alone (FR and EN)', async () => {
  const { createAdvisorTurn } = await import('../storefront-chat/advisor-tools.mjs');
  const talk = (messages) => {
    let state = null;
    return messages.map((message) => {
      const turn = createAdvisorTurn({ advisor, state, message, catalogue: CATALOGUE, money: (n) => `${n} €`, locale: 'fr' });
      const a = turn.opening();
      state = turn.nextState();
      return { p: turn.profile, a };
    });
  };
  // Cernes, then « que dois-je faire pour des rides »: the face's wrinkles, not the eye contour's.
  const [, rides, , creme] = talk(['Mes cernes et poches', 'Que dois-je faire pour des rides', 'mais pour les rides sur le visages', 'je cherche un creme pour les rides']);
  assert.equal(rides.p.primary_concern.value, 'wrinkles');
  assert.equal(rides.p.body_area.value, 'face');
  assert.match(rides.a.steps[0].handle, /temps-sublime/);
  assert.equal(creme.p.desired_care_type.value, 'moisturiser');
  assert.match(creme.a.steps[0].handle, /^creme-/);
  // Wrinkles, then « comment enlever mes taches », then « un serum »: a serum for the spots.
  const [, taches, serum] = talk(['je cherche un sérum pour les rides', 'comment enlever mes taches', 'un serum']);
  assert.equal(taches.p.primary_concern.value, 'dark_spots');
  assert.equal(taches.p.desired_care_type, undefined);
  assert.equal(serum.p.desired_care_type.value, 'serum');
  assert.match(serum.a.steps[0].handle, /taches/);
  const en = talk(['I need something for my dark circles', 'what can I do about wrinkles', 'how do I get rid of dark spots', 'a serum']);
  assert.deepEqual(en.map((t) => t.p.primary_concern.value), ['dark_circles', 'wrinkles', 'dark_spots', 'dark_spots']);
  assert.match(en[3].a.steps[0].handle, /taches/);
  // Kept: « aussi » adds a concern; a concern typed while another question is asked stays a second one.
  const [, also] = talk(['je cherche un sérum pour les rides', "j'ai aussi des taches"]);
  assert.equal(also.p.primary_concern.value, 'wrinkles');
  const answering = createAdvisorTurn({ advisor, state: { profile: { primary_concern: q('wrinkles') }, mode: 'routine_builder', asked: ['primary_concern', 'skin_type'], last_question: 'skin_type' }, message: 'peau grasse avec des imperfections', catalogue: CATALOGUE, money: (n) => `${n} €` });
  assert.equal(answering.profile.primary_concern.value, 'wrinkles');
  assert.equal(answering.profile.skin_type.value, 'oily');
});

test('« je veux une crème pour les taches » / "I want a cream for dark spots": the type and the new main concern (owner, 2026-10-19)', () => {
  const before = { primary_concern: q('wrinkles'), skin_type: q('dry') };
  for (const message of ['je veux une creme pour les taches', 'avez-vous une crème pour les taches ?', 'I want a cream for dark spots', 'is there a cream for dark spots?']) {
    const updates = extractProfile(message, { profile: before, lastAsked: null }).updates;
    assert.ok(updates.some((u) => u.field === 'desired_care_type' && u.value === 'moisturiser'), message);
    assert.ok(updates.some((u) => u.field === 'primary_concern' && u.value === 'dark_spots' && u.replace), message);
  }
});

test('a routine or ritual asked for starts the builder, FR and EN; one described does not (owner, 2026-10-19)', () => {
  for (const m of ['I would like a routine', 'can you suggest a skincare ritual', 'I need a new regimen', 'do you have a routine for dry skin', 'je veux une routine', 'proposez-moi un rituel', "j'aimerais une routine de soin complète", 'avez-vous une routine pour les rides ?']) assert.equal(extractProfile(m).routineBuilder, true, m);
  for (const m of ['my routine is a cleanser and a cream', 'what is in my routine', 'ma routine actuelle est un nettoyant', 'what spa treatments would you recommend']) assert.equal(extractProfile(m).routineBuilder, false, m);
});

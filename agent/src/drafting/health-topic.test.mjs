import assert from 'node:assert/strict';
import test from 'node:test';

import { autoSendBlockers, autoSendEligible, isParcelQuestion, situationKeysOf } from './draft-rules.mjs';
import { compileHealthTerms, customerTextFor, healthTermsIn, healthTopicOf } from './health-topic.mjs';

// --- the detector ------------------------------------------------------------

test('ba09c1ae: glaucoma in capitals, and « déconseillé » with its accent', () => {
  assert.deepEqual(
    healthTermsIn('Le masque Led Visage est il déconseillé pour une personne ayant un GLAUCOME ?'),
    ['glaucome', 'deconseille*']
  );
});

test('real health mentions from the corpus are caught', () => {
  assert.ok(healthTermsIn("je voudrais savoir si je peu l'utiliser malgré un glaucome").length > 0);
  assert.ok(healthTermsIn('un problème qui a été détecté par mon ophtalmologue').length > 0);
  assert.ok(healthTermsIn('je peux avoir des crises de rosacée').length > 0);
  assert.ok(healthTermsIn('une peau très réactive et sujette aux allergies').length > 0);
  assert.ok(healthTermsIn('Is it safe while pregnant?').length > 0);
  assert.ok(healthTermsIn('¿Se puede usar durante el embarazo?').length > 0);
  assert.ok(healthTermsIn('Darf ich das in der Schwangerschaft benutzen?').length > 0);
});

test('the two measured false positives stay out', () => {
  // « allergènes » is the labelling regulation; « médecine traditionnelle » a pitch.
  assert.deepEqual(healthTermsIn('la réglementation sur les allergènes'), []);
  assert.deepEqual(healthTermsIn("le rituel inspiré de la médecine traditionnelle coréenne"), []);
});

test('ordinary order mail is not a health topic', () => {
  assert.deepEqual(healthTermsIn('Le traitement de ma commande prend du temps, où en est mon colis ?'), []);
  assert.deepEqual(healthTermsIn('Mon code promo ne fonctionne pas'), []);
});

test('a whole word, not a fragment of one', () => {
  // `cancer*` must not fire inside another word.
  assert.deepEqual(healthTermsIn('anticancéreux'), []);
});

test('the list is data: a new term is picked up without code', () => {
  const compiled = compileHealthTerms({ fr: ['acouphene*'] });
  assert.deepEqual(healthTermsIn("J'ai des acouphènes", compiled), ['acouphene*']);
});

// --- what is read --------------------------------------------------------------

const at = (minutes) => new Date(Date.UTC(2026, 8, 25, 10, minutes)).toISOString();

test('an earlier customer message counts: the health fact and the question can be apart', () => {
  const conversation = [
    { id: 'm1', direction: 'inbound', actor: 'customer', body_text: "J'ai un glaucome.", received_at: at(0) },
    { id: 'm2', direction: 'outbound', body_text: 'Bonjour, quel produit ?', sent_at: at(5) },
    { id: 'm3', direction: 'inbound', actor: 'customer', body_text: 'Le masque LED, je peux ?', received_at: at(10) }
  ];
  assert.deepEqual(healthTopicOf({ conversation, triggerMessageId: 'm3' }), ['glaucome']);
});

test('a colleague’s note on the thread is not the customer describing themselves', () => {
  const conversation = [
    { id: 'm1', direction: 'inbound', actor: 'colleague', body_text: 'Cliente sous traitement, à voir.', received_at: at(0) },
    { id: 'm2', direction: 'inbound', actor: 'customer', body_text: 'Où en est ma commande ?', received_at: at(5) }
  ];
  assert.deepEqual(healthTopicOf({ conversation, triggerMessageId: 'm2' }), []);
});

test('our own reply is never read, even if it names a condition', () => {
  const conversation = [
    { id: 'm1', direction: 'outbound', body_text: 'En cas de grossesse, demandez à votre médecin.', sent_at: at(0) },
    { id: 'm2', direction: 'inbound', actor: 'customer', body_text: 'Merci !', received_at: at(5) }
  ];
  assert.deepEqual(healthTopicOf({ conversation, triggerMessageId: 'm2' }), []);
});

test('a message after the one being answered is not read', () => {
  const conversation = [
    { id: 'm1', direction: 'inbound', actor: 'customer', body_text: 'Où en est ma commande ?', received_at: at(0) },
    { id: 'm2', direction: 'inbound', actor: 'customer', body_text: 'Autre question : enceinte, je peux ?', received_at: at(5) }
  ];
  assert.deepEqual(healthTopicOf({ conversation, triggerMessageId: 'm1' }), []);
});

test('a row stored before `actor` existed is read as the customer', () => {
  const conversation = [{ id: 'm1', direction: 'inbound', body_text: 'Je suis enceinte.', received_at: at(0) }];
  assert.deepEqual(healthTopicOf({ conversation, triggerMessageId: 'm1' }), ['enceinte']);
});

test('the trigger is read even when the thread came back without it', () => {
  assert.match(customerTextFor({ conversation: [], message: { body_text: 'Je suis diabétique' }, triggerMessageId: 'm9' }), /diabétique/);
});

// --- the gate ------------------------------------------------------------------

const OK = { level: 1, happiness: 1, checksPassed: true, verdict: 'answerable' };

test('no blockers is exactly eligible', () => {
  assert.deepEqual(autoSendBlockers(OK), []);
  assert.equal(autoSendEligible(OK), true);
});

test('a health topic holds a draft every other gate would send', () => {
  assert.equal(autoSendEligible({ ...OK, healthTerms: ['glaucome'] }), false);
  assert.deepEqual(autoSendBlockers({ ...OK, healthTerms: ['glaucome', 'deconseille*'] }), [
    { reason: 'health_topic', detail: 'glaucome, deconseille' }
  ]);
});

test('a held situation holds it too', () => {
  assert.deepEqual(autoSendBlockers({ ...OK, heldSituations: ['CV-03'] }), [{ reason: 'situation', detail: 'CV-03' }]);
});

test('every reason is listed, not only the first', () => {
  const reasons = autoSendBlockers({
    level: 3,
    happiness: 4,
    checksPassed: false,
    verdict: 'needs_human',
    category: 'cosmetovigilance',
    healthTerms: ['enceinte'],
    heldSituations: ['CV-01']
  }).map((b) => b.reason);
  assert.deepEqual(reasons, ['cosmetovigilance', 'health_topic', 'situation', 'needs_human', 'level', 'unhappy', 'checks_failed']);
});

test('the situations a case file answers: the match, each request, the casework reading', () => {
  assert.deepEqual(
    situationKeysOf({
      exemplarMatch: {
        exemplar_key: 'PR-26',
        policy: { situation_key: 'PR-26', per_request: [{ situation_key: 'PR-26' }, { situation_key: 'CV-03' }] }
      },
      caseState: { situation_key: 'CV-01' }
    }),
    ['PR-26', 'CV-03', 'CV-01']
  );
  assert.deepEqual(situationKeysOf({}), []);
});

// --- « where is my parcel » --------------------------------------------------


const SCOPE = {
  parcelRules: new Set(['orders/expediee_sans_scan', 'orders/colis_en_transit']),
  parcelSituations: new Set(['D-01', 'D-36'])
};

test('the selected rule decides: one reading where the parcel is', () => {
  assert.equal(isParcelQuestion({ exemplarMatch: { exemplar_key: 'O-09', policy: { answer_set: 'orders', answer_key: 'expediee_sans_scan' } }, scope: SCOPE }), true);
});

test('#6913: a promotion rule on an order ticket is not a parcel question', () => {
  assert.equal(isParcelQuestion({ exemplarMatch: { exemplar_key: 'P-22', policy: { answer_set: 'orders', answer_key: 'p22_aucune_promotion' } }, scope: SCOPE }), false);
});

test('a selected rule outranks the situation: D-36 answered by its refund rule is not one', () => {
  assert.equal(isParcelQuestion({ exemplarMatch: { exemplar_key: 'D-36', policy: { answer_set: 'orders', answer_key: 'retard_client_veut_sortir' } }, scope: SCOPE }), false);
});

test('two requests: either one about the parcel makes the reply one', () => {
  const exemplarMatch = {
    policy: {
      answer_set: 'orders',
      answer_key: 'p22_aucune_promotion',
      per_request: [
        { answer_set: 'orders', answer_key: 'p22_aucune_promotion' },
        { answer_set: 'orders', answer_key: 'colis_en_transit' }
      ]
    }
  };
  assert.equal(isParcelQuestion({ exemplarMatch, scope: SCOPE }), true);
});

test('no rule selected: the situation’s declared needs decide', () => {
  assert.equal(isParcelQuestion({ exemplarMatch: { exemplar_key: 'D-01', policy: { answer_key: null } }, scope: SCOPE }), true);
  assert.equal(isParcelQuestion({ exemplarMatch: { exemplar_key: 'D-02' }, scope: SCOPE }), false);
  assert.equal(isParcelQuestion({ exemplarMatch: null, scope: SCOPE }), false);
});

test('without a scope it cannot tell, and says so', () => {
  assert.equal(isParcelQuestion({ exemplarMatch: { exemplar_key: 'D-01' } }), undefined);
});

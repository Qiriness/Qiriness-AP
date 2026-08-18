import assert from 'node:assert/strict';
import test from 'node:test';

import { CAVEATS, MISSING_FIELDS } from '../investigation/case-file.mjs';
import {
  ADVISORY_CAVEATS,
  ASK_TERMS,
  MECHANICAL_PROHIBITIONS,
  checksPassed,
  failedChecks,
  runDraftChecks
} from './draft-checks.mjs';

const SIGNATURE = 'Bien cordialement,\nService Client Qiriness';

const clean =
  'Bonjour Madame,\n\nVotre commande est en cours de préparation.\n\n' + SIGNATURE;

function check(checks, name) {
  return checks.find((entry) => entry.check === name);
}

// --- the vocabulary is shared with the investigation -------------------------

test('every prohibition it checks is a caveat the investigation can raise', () => {
  // The codes are the seam between the tools and the case file; inventing one
  // here would produce a check that can never fire.
  for (const code of Object.keys(MECHANICAL_PROHIBITIONS)) {
    assert.ok(CAVEATS[code], `${code} is not a caveat`);
  }
  for (const code of ADVISORY_CAVEATS) {
    assert.ok(CAVEATS[code], `${code} is not a caveat`);
  }
});

test('every caveat is either checked or declared unexaminable', () => {
  // The honesty property: a suite that reports 100% while testing 60% is worse
  // than one that says which 60%, because the first number is the one quoted.
  const covered = new Set([...Object.keys(MECHANICAL_PROHIBITIONS), ...ADVISORY_CAVEATS]);
  for (const code of Object.keys(CAVEATS)) {
    assert.ok(covered.has(code), `${code} is neither checked nor declared advisory`);
  }
});

// --- only the prohibitions this ticket raised --------------------------------

test('a prohibition nobody imposed is not checked', () => {
  const checks = runDraftChecks({ body: 'Le produit sera de retour en stock lundi.' });
  assert.equal(check(checks, 'do_not_claim:stock_unknown'), undefined);
});

test('the same sentence fails once the caveat is raised', () => {
  const checks = runDraftChecks({
    body: 'Le produit sera de retour en stock lundi.',
    doNotClaim: [CAVEATS.stock_unknown]
  });
  const entry = check(checks, 'do_not_claim:stock_unknown');
  assert.equal(entry.passed, false);
  assert.match(entry.detail, /de retour en stock/);
});

test('the prohibition is against the claim, not against the subject', () => {
  // A correct reply explaining that stock cannot be confirmed obviously
  // contains the word "stock". Firing on that would get the check ignored.
  const checks = runDraftChecks({
    body: 'Nous ne sommes pas en mesure de confirmer la disponibilité en stock de ce produit.',
    doNotClaim: [CAVEATS.stock_unknown]
  });
  assert.equal(check(checks, 'do_not_claim:stock_unknown').passed, true);
});

test('denying the purchase is caught — the worst reply this exists to prevent', () => {
  const checks = runDraftChecks({
    body: 'Aucune commande n’a été trouvée à votre nom.',
    doNotClaim: [CAVEATS.purchase_unverified]
  });
  assert.equal(check(checks, 'do_not_claim:purchase_unverified').passed, false);
});

test('denying a photo is caught', () => {
  const checks = runDraftChecks({
    body: 'Nous n’avons pas reçu de photo de votre part.',
    doNotClaim: [CAVEATS.attachments_unrecorded]
  });
  assert.equal(check(checks, 'do_not_claim:attachments_unrecorded').passed, false);
});

test('promising the promo code will work is caught', () => {
  const checks = runDraftChecks({
    body: 'Votre code est bien valide, réessayez.',
    doNotClaim: [CAVEATS.eligibility_undetermined]
  });
  assert.equal(check(checks, 'do_not_claim:eligibility_undetermined').passed, false);
});

test('an unexaminable prohibition is recorded as null, never as a pass', () => {
  const checks = runDraftChecks({ body: clean, doNotClaim: [CAVEATS.knowledge_none] });
  const entry = check(checks, 'do_not_claim:knowledge_none');
  assert.equal(entry.passed, null);
  assert.match(entry.detail, /not mechanically checkable/);
});

test('an unexaminable prohibition does not fail the draft', () => {
  // Refusing every draft carrying one would refuse most of them.
  const checks = runDraftChecks({ body: clean, doNotClaim: [CAVEATS.knowledge_none] });
  assert.equal(checksPassed(checks), true);
});

// --- what no reply may contain -----------------------------------------------

test('a technical identifier is caught', () => {
  for (const body of [
    'Référence gid://shopify/Product/123',
    'Le SKU concerné est QIR-01',
    'Dossier 3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071'
  ]) {
    assert.equal(check(runDraftChecks({ body }), 'no_internal_identifier').passed, false, body);
  }
});

test('an order number is not a technical identifier', () => {
  // #6686 is what the customer reads on their own confirmation email.
  assert.equal(
    check(runDraftChecks({ body: 'Votre commande #6686 est en préparation.' }), 'no_internal_identifier')
      .passed,
    true
  );
});

test('any email address at all is caught', () => {
  // The customer's is withheld by default and the shop's is not needed — the
  // reply arrives from it.
  assert.equal(
    check(runDraftChecks({ body: 'Écrivez à contact@qiriness.com' }), 'no_email_address').passed,
    false
  );
});

test('internal machinery is caught, straight from the guardrail list', () => {
  for (const body of [
    'D’après notre base de connaissances, ce produit est arrêté.',
    'Notre outil interne indique un retard.',
    'Ce ticket est classé en niveau 3 chez nous.'
  ]) {
    assert.equal(check(runDraftChecks({ body }), 'no_internal_machinery').passed, false, body);
  }
});

test('a clean reply passes everything', () => {
  const checks = runDraftChecks({ body: clean, signature: SIGNATURE });
  assert.deepEqual(failedChecks(checks), []);
  assert.equal(checksPassed(checks), true);
});

// --- the stored questions ----------------------------------------------------

test('the stored question embedded mid-sentence passes', () => {
  // THE CASE THAT CHANGED THIS CHECK. Measured on live case files, the model
  // reproduced the stored sentence verbatim and lowercased its first letter to
  // join it to a lead-in. Exact containment called that a violation; it is not
  // one, and treating it as one fired on 6 of 6 real drafts.
  const checks = runDraftChecks({
    body:
      'Bonjour,\n\nAfin de vérifier, ' +
      MISSING_FIELDS.shopify_order_number.ask.replace('Pourriez', 'pourriez') +
      `\n\n${SIGNATURE}`,
    verdict: 'needs_customer_input',
    missing: [{ field: 'shopify_order_number' }]
  });
  assert.equal(check(checks, 'asks:shopify_order_number').passed, true);
});

test('every requestable fact declares how to check it was asked for', () => {
  // The drift guard on the third copy of this vocabulary: adding a field to
  // MISSING_FIELDS without deciding what naming it looks like would produce a
  // check that passes on any text at all.
  for (const field of Object.keys(MISSING_FIELDS)) {
    assert.ok(ASK_TERMS[field]?.length > 0, `${field} has no ASK_TERMS entry`);
  }
});

test('a freely reworded question still passes when it names the fact', () => {
  // THE SECOND CASE THAT CHANGED THIS CHECK, measured on a real run: word
  // coverage scored this 43% against the stored sentence, versus 15% for a
  // draft about a different field — a real gap, far too narrow for a threshold.
  const checks = runDraftChecks({
    body: `Bonjour,\n\npourriez-vous nous indiquer l'adresse e-mail utilisée pour passer cette commande ?\n\n${SIGNATURE}`,
    verdict: 'needs_customer_input',
    missing: [{ field: 'purchase_email' }]
  });
  assert.equal(check(checks, 'asks:purchase_email').passed, true);
});

test('accents and plurals do not decide whether a fact was asked for', () => {
  const checks = runDraftChecks({
    body: `Bonjour,\n\nQuel est le numero de vos commandes ?\n\n${SIGNATURE}`,
    verdict: 'needs_customer_input',
    missing: [{ field: 'shopify_order_number' }]
  });
  assert.equal(check(checks, 'asks:shopify_order_number').passed, true);
});

test('a failure names the term that was missing', () => {
  // A reviewer has to be able to see WHY without re-reading the reply.
  const checks = runDraftChecks({
    body: `Bonjour,\n\nQuelle est la date de votre commande ?\n\n${SIGNATURE}`,
    verdict: 'needs_customer_input',
    missing: [{ field: 'order_date_or_amount' }]
  });
  const entry = check(checks, 'asks:order_date_or_amount');
  assert.equal(entry.passed, false);
  assert.match(entry.detail, /montant/);
});

test('a draft that asks for nothing fails', () => {
  const checks = runDraftChecks({
    body: `Bonjour,\n\nVotre commande est en préparation.\n\n${SIGNATURE}`,
    verdict: 'needs_customer_input',
    missing: [{ field: 'shopify_order_number' }]
  });
  assert.equal(check(checks, 'asks:shopify_order_number').passed, false);
});

test('a draft that asks about the wrong field fails', () => {
  // The failure actually worth catching: the case file named the order number
  // and the reply asked for a photo.
  const checks = runDraftChecks({
    body: `Bonjour,\n\nPourriez-vous nous envoyer une photo du produit ?\n\n${SIGNATURE}`,
    verdict: 'needs_customer_input',
    missing: [{ field: 'shopify_order_number' }]
  });
  assert.equal(check(checks, 'asks:shopify_order_number').passed, false);
});

test('whether it was reproduced word for word is recorded, never enforced', () => {
  // The measurement that survived the change: how much rewording happens is
  // worth counting across a batch and is not a reason to hold a draft back.
  const reworded = runDraftChecks({
    body: `Bonjour,\n\npourriez-vous nous indiquer avec quelle adresse e-mail la commande a été passée ?\n\n${SIGNATURE}`,
    verdict: 'needs_customer_input',
    missing: [{ field: 'purchase_email' }]
  });
  const entry = check(reworded, 'asks_verbatim:purchase_email');
  assert.equal(entry.passed, null);
  assert.match(entry.detail, /reformulée/);
  assert.equal(checksPassed(reworded), true);

  const exact = runDraftChecks({
    body: `Bonjour,\n\n${MISSING_FIELDS.purchase_email.ask}\n\n${SIGNATURE}`,
    verdict: 'needs_customer_input',
    missing: [{ field: 'purchase_email' }]
  });
  assert.match(check(exact, 'asks_verbatim:purchase_email').detail, /mot pour mot/);
});

test('the stored wording passes, whatever the surrounding whitespace', () => {
  const checks = runDraftChecks({
    body: `Bonjour,\n\n${MISSING_FIELDS.shopify_order_number.ask.replace(/ /g, '\n')}\n\n${SIGNATURE}`,
    verdict: 'needs_customer_input',
    missing: [{ field: 'shopify_order_number' }]
  });
  assert.equal(check(checks, 'asks:shopify_order_number').passed, true);
});

test('the question check only applies to the verdict that asks', () => {
  const checks = runDraftChecks({
    body: clean,
    verdict: 'answerable',
    missing: [{ field: 'shopify_order_number' }]
  });
  assert.equal(check(checks, 'asks:shopify_order_number'), undefined);
});

// --- the signature -----------------------------------------------------------

test('the signature has to end the reply, not merely appear in it', () => {
  // A signature in the middle is a model that carried on writing after signing
  // off.
  const checks = runDraftChecks({
    body: `${SIGNATURE}\n\nPS : autre chose.`,
    signature: SIGNATURE
  });
  assert.equal(check(checks, 'signature').passed, false);
});

test('an altered signature fails', () => {
  const checks = runDraftChecks({
    body: 'Bonjour,\n\nMerci.\n\nCordialement,\nL’équipe Qiriness',
    signature: SIGNATURE
  });
  assert.equal(check(checks, 'signature').passed, false);
});

test('no configured signature means no signature check', () => {
  const checks = runDraftChecks({ body: 'Bonjour,\n\nMerci.', signature: '' });
  assert.equal(check(checks, 'signature'), undefined);
});

// --- the summary functions ---------------------------------------------------

test('failedChecks reports what a reviewer has to read, and nothing else', () => {
  const checks = runDraftChecks({
    body: 'Aucune commande n’a été trouvée. Écrivez à x@y.com',
    doNotClaim: [CAVEATS.purchase_unverified, CAVEATS.knowledge_none]
  });
  const failures = failedChecks(checks);
  assert.equal(failures.length, 2);
  assert.ok(failures.some((detail) => /nie l’achat/.test(detail)));
  assert.ok(failures.some((detail) => /adresse e-mail/.test(detail)));
});

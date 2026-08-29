import assert from 'node:assert/strict';
import test from 'node:test';

import { CAVEATS, MISSING_FIELDS } from '../investigation/case-file.mjs';
import {
  ACKNOWLEDGEMENT_PROHIBITIONS,
  ADVISORY_CAVEATS,
  ASK_TERMS,
  MECHANICAL_PROHIBITIONS,
  SIGNATURE_LANGUAGE,
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

// --- what only an acknowledgement is forbidden -------------------------------

const ACK = { verdict: 'needs_human', signature: SIGNATURE };

test('a promised deadline is caught — the one that costs money', () => {
  // « Nous revenons vers vous sous 24 heures » is the most natural way to end a
  // holding reply and a commitment nobody agreed to. The customer who does not
  // hear back in 24 hours now has a second complaint that is entirely ours.
  for (const body of [
    `Bonjour,

Nous revenons vers vous sous 24 heures.

${SIGNATURE}`,
    `Bonjour,

Une réponse vous parviendra d’ici la fin de la semaine.

${SIGNATURE}`,
    `Bonjour,

Nous vous répondrons dans les 48 heures.

${SIGNATURE}`
  ]) {
    assert.equal(check(runDraftChecks({ ...ACK, body }), 'no_promised_deadline').passed, false, body);
  }
});

test('a holding reply with no deadline passes', () => {
  const body =
    `Bonjour Catherine,

Nous avons bien reçu votre message concernant votre commande. ` +
    `Votre demande est prise en charge par notre équipe, qui reviendra vers vous.

${SIGNATURE}`;
  assert.equal(checksPassed(runDraftChecks({ ...ACK, body })), true);
});

test('a promised outcome is caught', () => {
  const body = `Bonjour,

Nous allons vous rembourser cette commande.

${SIGNATURE}`;
  assert.equal(check(runDraftChecks({ ...ACK, body }), 'no_promise').passed, false);
});

test('a question invented by an acknowledgement is caught', () => {
  // The case file named nothing to ask for, so any request is one the model
  // invented — and the customer will answer it, turning a holding note into a
  // thread nobody meant to open.
  const body = `Bonjour,

Pourriez-vous nous indiquer votre numéro de commande ?

${SIGNATURE}`;
  assert.equal(check(runDraftChecks({ ...ACK, body }), 'no_invented_question').passed, false);
});

const NL = String.fromCharCode(10);
const wrap = (middle) => 'Bonjour,' + NL + NL + middle + NL + NL + SIGNATURE;

test('the handover-only prohibitions apply to handovers only', () => {
  const checks = runDraftChecks({
    body: wrap('Pourriez-vous nous indiquer le code promotionnel ?'),
    verdict: 'needs_customer_input',
    missing: [{ field: 'promotion_code' }],
    signature: SIGNATURE
  });
  for (const { check: name } of ACKNOWLEDGEMENT_PROHIBITIONS) {
    assert.equal(check(checks, name), undefined, name + ' must not apply here');
  }
  // It was asked to ask, so it is scored on WHAT it asked for, not on whether.
  assert.equal(check(checks, 'no_invented_question'), undefined);
  assert.equal(check(checks, 'asks:promotion_code').passed, true);
});

test('asking is licensed by the case file, not by the verdict', () => {
  // ONE RULE, THREE INSTRUCTIONS: "do not ask for more" on an answer, "ask only
  // for this" on a question, and "ask only if the dossier names one" on a
  // handover are the same rule seen from three sides.
  const asks = wrap('Pourriez-vous nous indiquer votre numéro de commande ?');

  for (const verdict of ['answerable', 'needs_human']) {
    assert.equal(
      check(runDraftChecks({ body: asks, verdict, signature: SIGNATURE }), 'no_invented_question').passed,
      false,
      verdict
    );
  }

  const licensed = runDraftChecks({
    body: asks,
    verdict: 'needs_human',
    missing: [{ field: 'shopify_order_number' }],
    signature: SIGNATURE
  });
  assert.equal(check(licensed, 'no_invented_question'), undefined);
  assert.equal(check(licensed, 'asks:shopify_order_number').passed, true);
});

test('an answerable case file never licenses a question, even carrying a missing field', () => {
  // The verdict says the dossier is sufficient; a follow-up on top of a complete
  // answer is the padding the brand voice rejects.
  const checks = runDraftChecks({
    body: wrap('Votre commande part demain. Pourriez-vous nous indiquer votre numéro de commande ?'),
    verdict: 'answerable',
    missing: [{ field: 'shopify_order_number' }],
    signature: SIGNATURE
  });
  assert.equal(check(checks, 'no_invented_question').passed, false);
  assert.equal(check(checks, 'asks:shopify_order_number'), undefined);
});

test('claiming a check has already happened is caught', () => {
  for (const middle of [
    'Après vérification, votre colis est bien perdu.',
    'Nous avons vérifié votre commande.',
    'Notre équipe a confirmé le problème.'
  ]) {
    assert.equal(
      check(
        runDraftChecks({ body: wrap(middle), verdict: 'needs_human', signature: SIGNATURE }),
        'no_completed_action'
      ).passed,
      false,
      middle
    );
  }
});

test('confirming receipt of the message is not a completed action', () => {
  // "Nous avons bien recu votre message" must stay allowed, so the pattern is
  // keyed on the verbs of checking rather than on "nous avons".
  const checks = runDraftChecks({
    body: wrap('Nous avons bien reçu votre message.'),
    verdict: 'needs_human',
    signature: SIGNATURE
  });
  assert.equal(check(checks, 'no_completed_action').passed, true);
});

// --- the approved closing line -----------------------------------------------

const CLOSING = 'N’hésitez pas à revenir vers nous si vous avez d’autres questions.';

test('the approved closing line is checked exactly, like the signature', () => {
  const ok = runDraftChecks({
    body: wrap('Votre commande part demain.' + NL + NL + CLOSING),
    verdict: 'answerable',
    closingLine: CLOSING,
    signature: SIGNATURE
  });
  assert.equal(check(ok, 'closing_line').passed, true);

  const missing = runDraftChecks({
    body: wrap('Votre commande part demain.'),
    verdict: 'answerable',
    closingLine: CLOSING,
    signature: SIGNATURE
  });
  assert.equal(check(missing, 'closing_line').passed, false);
});

test('no configured closing line means no closing-line check', () => {
  const checks = runDraftChecks({
    body: wrap('Votre commande part demain.'),
    verdict: 'answerable',
    signature: SIGNATURE
  });
  assert.equal(check(checks, 'closing_line'), undefined);
});

test('the approved line is not itself flagged as invented courtesy', () => {
  // It contains "n'hesitez pas a revenir vers nous", which the advisory pattern
  // matches on purpose — so the advisory runs on the text with the approved line
  // removed, or approving a wording would flag every draft that used it.
  const checks = runDraftChecks({
    body: wrap('Votre commande part demain.' + NL + NL + CLOSING),
    verdict: 'answerable',
    closingLine: CLOSING,
    signature: SIGNATURE
  });
  assert.match(check(checks, 'empty_closer').detail, /aucune formule/);
});

test('a second courtesy line beside the approved one is still recorded', () => {
  const checks = runDraftChecks({
    body: wrap('Votre commande part demain.' + NL + NL + 'Merci de votre patience.' + NL + NL + CLOSING),
    verdict: 'answerable',
    closingLine: CLOSING,
    signature: SIGNATURE
  });
  const entry = check(checks, 'empty_closer');
  assert.equal(entry.passed, null);
  assert.match(entry.detail, /non approuvée/);
});

test('an invented courtesy line never fails a draft', () => {
  // A weak sentence, not a wrong one, and checks_passed gates auto-send.
  const checks = runDraftChecks({
    body: wrap('Votre commande part demain.' + NL + NL + 'Nous restons a votre disposition.'),
    verdict: 'answerable',
    signature: SIGNATURE
  });
  assert.equal(check(checks, 'empty_closer').passed, null);
  assert.equal(checksPassed(checks), true);
});

test('courtesy inside the signature is approved text, not invented text', () => {
  // Measured on the live brand-voice row: the sentence was written into the
  // signature field before a Closing line field existed. Text a person approved
  // is not text a model invented, whichever field it was approved in.
  const combined = CLOSING + NL + NL + SIGNATURE;
  const checks = runDraftChecks({
    body: 'Bonjour,' + NL + NL + 'Votre commande part demain.' + NL + NL + combined,
    verdict: 'answerable',
    signature: combined
  });
  assert.equal(check(checks, 'signature').passed, true);
  assert.match(check(checks, 'empty_closer').detail, /aucune formule/);
});

// --- the carrier-scan leak ---------------------------------------------------

test('the carrier-scan wording is refused on every reply', () => {
  // MEASURED: 8 of 81 drafts said this to a customer, several naming the
  // carrier. No carrier feeds scan events into Shopify for this store, so it
  // blamed Colissimo and GLS for a gap in our own integration — and it is not
  // the customer's business on any ticket, whatever the case file raised.
  for (const middle of [
    'Il semble qu’il n’y ait pas encore de scan de suivi disponible de la part de Colissimo.',
    'Aucun scan transporteur n’est disponible pour le moment.'
  ]) {
    const checks = runDraftChecks({ body: wrap(middle), verdict: 'answerable', signature: SIGNATURE });
    assert.equal(check(checks, 'no_carrier_scan_wording').passed, false, middle);
  }
});

test('stating the dispatch date is not a leak', () => {
  // What the model is now told is true and customer-safe: it was dispatched,
  // and when.
  const checks = runDraftChecks({
    body: wrap('Votre commande a été expédiée le 21 juillet.'),
    verdict: 'answerable',
    signature: SIGNATURE
  });
  assert.equal(check(checks, 'no_carrier_scan_wording').passed, true);
});

test('the unscanned prohibition stops the model describing the parcel', () => {
  for (const middle of [
    'Votre colis est actuellement en cours d’acheminement.',
    'Le suivi n’affiche aucune information pour le moment.'
  ]) {
    const checks = runDraftChecks({
      body: wrap(middle),
      verdict: 'answerable',
      doNotClaim: [CAVEATS.delivery_unscanned],
      signature: SIGNATURE
    });
    assert.equal(check(checks, 'do_not_claim:delivery_unscanned').passed, false, middle);
  }
});

// --- the apology we owe ------------------------------------------------------

test('a chased customer must be apologised to', () => {
  const checks = runDraftChecks({
    body: wrap('Votre commande part demain.'),
    verdict: 'answerable',
    chased: true,
    signature: SIGNATURE
  });
  assert.equal(check(checks, 'apologises_for_delay').passed, false);
});

test('an apology for the delay satisfies it', () => {
  const checks = runDraftChecks({
    body: wrap('Nous sommes désolés pour le délai de notre réponse. Votre commande part demain.'),
    verdict: 'answerable',
    chased: true,
    signature: SIGNATURE
  });
  assert.equal(check(checks, 'apologises_for_delay').passed, true);
});

test('a customer who was not left waiting is not owed one', () => {
  // The check rests on a fact about the envelopes; the broader rule about a
  // customer who SAYS they have been waiting stays the prompt's job.
  const checks = runDraftChecks({
    body: wrap('Votre commande part demain.'),
    verdict: 'answerable',
    signature: SIGNATURE
  });
  assert.equal(check(checks, 'apologises_for_delay'), undefined);
});

test('an apology is recognised in every language the corpus drafts in', () => {
  // MEASURED: the first version matched French only and failed an Italian draft
  // opening "Ci scusiamo per il ritardo nella risposta" — a correct reply marked
  // wrong, which is how a check earns being ignored.
  const byLanguage = {
    fr: 'Nous sommes désolés pour le délai de notre réponse.',
    it: 'Ci scusiamo per il ritardo nella risposta.',
    en: 'We are sorry for the delay in replying.',
    es: 'Lamentamos la demora en responder.'
  };
  for (const [language, line] of Object.entries(byLanguage)) {
    const checks = runDraftChecks({
      body: wrap(line + ' Votre commande part demain.'),
      verdict: 'answerable',
      chased: true,
      signature: SIGNATURE
    });
    assert.equal(check(checks, 'apologises_for_delay').passed, true, language);
  }
});

// --- a reply carries no web addresses ----------------------------------------

const LINK = 'https://www.laposte.fr/outils/suivre-vos-envois?code=6C20723002488';

test('a URL in a reply fails the draft, tracking link included', () => {
  // The tracking link is not the exception, it is the case that produced the
  // rule: given the URL, the model pastes 70 characters into the prose. The
  // parcel NUMBER carries the same information and is what becomes clickable.
  const checks = runDraftChecks({ body: `Suivez votre colis : ${LINK}

${SIGNATURE}` });
  assert.equal(check(checks, 'no_web_link').passed, false);
  assert.equal(checksPassed(checks), false);
  assert.ok(failedChecks(checks).some((detail) => detail.includes('contient un lien')));
});

test('markdown and HTML links fail too, because nothing renders them', () => {
  // MEASURED: the first run with a URL in the prompt wrote
  // « [Suivi Colissimo](https://…) ». The reply is plain text, so the customer
  // would have received the brackets around their own tracking link.
  for (const body of [`[Suivi Colissimo](${LINK})`, `<a href="${LINK}">le suivi</a>`]) {
    assert.equal(check(runDraftChecks({ body }), 'no_web_link').passed, false, body);
  }
});

test('a bare host with no scheme is still a link', () => {
  assert.equal(
    check(runDraftChecks({ body: 'Voir www.qiriness.com pour nos conditions.' }), 'no_web_link').passed,
    false
  );
});

test('the parcel number itself is not a link and passes', () => {
  // What a correct reply looks like: the number, which every surface renders as
  // a link to the carrier without a URL ever appearing in the text.
  const checks = runDraftChecks({
    body: `Bonjour,

Votre colis 6C20723002488 (COLISSIMO) est en route.

${SIGNATURE}`
  });
  assert.equal(check(checks, 'no_web_link').passed, true);
});

// --- the signature, when the reply is not in French --------------------------

test('a French reply is still compared character by character', () => {
  assert.equal(check(runDraftChecks({ body: clean, signature: SIGNATURE }), 'signature').passed, true);
  assert.equal(
    check(runDraftChecks({ body: `Bonjour.

Cordialement, Qiriness`, signature: SIGNATURE }), 'signature').passed,
    false
  );
});

test('a reply in another language that closed in French fails', () => {
  // THE REPORTED BUG. An Italian body signed off « Bien Cordialement, / Service
  // Client Qiriness » — correct per the old prompt, and wrong to the person
  // reading it. It passed, because the check compared it to the French text.
  const checks = runDraftChecks({
    body: `Buongiorno,

Il suo ordine è stato spedito.

${SIGNATURE}`,
    signature: SIGNATURE,
    language: 'it'
  });
  assert.equal(check(checks, 'signature').passed, false);
  assert.match(check(checks, 'signature').detail, /non traduite/);
  assert.equal(checksPassed(checks), false);
});

test('a translated signature is advisory, not a pass and not a failure', () => {
  // A pattern loose enough to accept a signature in seven languages would accept
  // anything, so this reports "read it" rather than claiming coverage it has
  // not got — the same honesty rule as ADVISORY_CAVEATS.
  const checks = runDraftChecks({
    body: `Buongiorno,

Il suo ordine è stato spedito.

Cordiali saluti,
Servizio Clienti Qiriness`,
    signature: SIGNATURE,
    language: 'it'
  });
  assert.equal(check(checks, 'signature').passed, null);
  assert.match(check(checks, 'signature').detail, /non comparable/);
  assert.equal(checksPassed(checks), true, 'advisory must not hold the draft back');
});

test('the language defaults to the one the signature is written in', () => {
  // A caller that does not pass a language gets the old behaviour exactly.
  assert.equal(SIGNATURE_LANGUAGE, 'fr');
  assert.equal(check(runDraftChecks({ body: clean, signature: SIGNATURE }), 'signature').passed, true);
});

test('the ask check is advisory on a reply that is not in French', () => {
  // ASK_TERMS is French vocabulary. « numero d'ordine » is a correct Italian
  // request for an order number and contains no « commande », so the check can
  // only report the absence of words the reply had no reason to carry.
  const missing = [{ field: 'shopify_order_number', why: 'Le client ne l a pas donné.' }];
  const italian = runDraftChecks({
    body: `Buongiorno,

Può indicarci il numero d ordine?

Cordiali saluti`,
    missing,
    verdict: 'needs_customer_input',
    language: 'it'
  });
  assert.equal(check(italian, 'asks:shopify_order_number').passed, null);
  assert.equal(checksPassed(italian), true, 'advisory must not hold the draft back');

  // French is unchanged: still examined, still fails when the words are absent.
  const french = runDraftChecks({
    body: `Bonjour,

Pouvez-vous nous indiquer de quoi il s agit ?`,
    missing,
    verdict: 'needs_customer_input',
    language: 'fr'
  });
  assert.equal(check(french, 'asks:shopify_order_number').passed, false);
});

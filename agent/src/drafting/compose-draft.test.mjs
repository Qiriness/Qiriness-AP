import assert from 'node:assert/strict';
import test from 'node:test';

import { MISSING_FIELDS } from '../investigation/case-file.mjs';
import {
  DRAFT_SCHEMA,
  caseFileFromRow,
  composeDraftingMessage,
  promptInputs
} from './compose-draft.mjs';

const ROW = {
  id: 'investigation-1',
  verdict: 'answerable',
  established: [{ claim: 'La commande #6686 est en préparation.' }],
  unverified: [{ claim: 'Le client dit avoir été débité deux fois.', why: 'aucun outil' }],
  missing: [],
  do_not_claim: ['Ne pas affirmer une date d’expédition précise.'],
  knowledge: [{ title: 'Délais de préparation', text: 'Comptez 2 à 3 jours ouvrés.' }],
  // Present on the stored row and deliberately not mapped.
  handoff: { action: 'Rembourser le client', why: 'double débit' },
  tool_calls: [{ id: 'c1', tool: 'getOrderContext', outcome: 'ok' }],
  dropped_claims: ['Le colis a été livré.']
};

const MESSAGE = { subject: 'Où est ma commande ?', body_text: 'Bonjour, ma commande #6686…' };

// --- reading the stored case file back ---------------------------------------

test('the internal columns are not mapped at all', () => {
  // The same guarantee toDraftingPrompt makes one layer up: what is never read
  // cannot be rendered.
  const caseFile = caseFileFromRow(ROW);
  assert.ok(!('handoff' in caseFile));
  assert.ok(!('toolCalls' in caseFile));
  assert.ok(!('droppedClaims' in caseFile));
});

test('a malformed row reads as empty lists rather than throwing', () => {
  const caseFile = caseFileFromRow({ verdict: 'answerable', established: null });
  assert.deepEqual(caseFile.established, []);
  assert.deepEqual(caseFile.knowledge, []);
});

test('a row with no verdict is treated as needing a human', () => {
  assert.equal(caseFileFromRow({}).verdict, 'needs_human');
});

// --- the composed message ----------------------------------------------------

test('the customer’s own words come first', () => {
  // A model handed conclusions before the question tends to answer the
  // conclusions.
  const composed = composeDraftingMessage({ message: MESSAGE, caseFile: caseFileFromRow(ROW) });
  assert.ok(composed.startsWith('# Message du client'));
  assert.ok(composed.indexOf('ma commande #6686') < composed.indexOf('# Dossier'));
});

test('the internal handoff never reaches the composed message', () => {
  const composed = composeDraftingMessage({ message: MESSAGE, caseFile: caseFileFromRow(ROW) });
  assert.ok(!composed.includes('Rembourser le client'));
  assert.ok(!composed.includes('getOrderContext'));
  assert.ok(!composed.includes('Le colis a été livré.'));
});

test('the established facts and the prohibitions do reach it', () => {
  const composed = composeDraftingMessage({ message: MESSAGE, caseFile: caseFileFromRow(ROW) });
  assert.ok(composed.includes('La commande #6686 est en préparation.'));
  assert.ok(composed.includes('Ne pas affirmer une date d’expédition précise.'));
  assert.ok(composed.includes('Comptez 2 à 3 jours ouvrés.'));
});

test('the stored question is what travels, not the field name', () => {
  const composed = composeDraftingMessage({
    message: MESSAGE,
    caseFile: caseFileFromRow({
      ...ROW,
      verdict: 'needs_customer_input',
      missing: [{ field: 'shopify_order_number' }]
    })
  });
  assert.ok(composed.includes(MISSING_FIELDS.shopify_order_number.ask));
  assert.ok(!composed.includes('shopify_order_number'));
});

test('a subjectless message is labelled rather than left blank', () => {
  const composed = composeDraftingMessage({
    message: { subject: '  ', body_text: 'x' },
    caseFile: caseFileFromRow(ROW)
  });
  assert.ok(composed.includes('(sans objet)'));
});

// --- the order bundle --------------------------------------------------------

test('no bundle means no order section, not an apology for its absence', () => {
  // 138 of 214 tickets have no confirmed order. The absence is the normal case.
  const composed = composeDraftingMessage({
    message: MESSAGE,
    caseFile: caseFileFromRow(ROW),
    orderContext: null
  });
  assert.ok(!composed.includes('## Commande concernée'));
});

test('a bundle is rendered through the model projection, never dumped', () => {
  const composed = composeDraftingMessage({
    message: MESSAGE,
    caseFile: caseFileFromRow(ROW),
    orderContext: {
      order: {
        name: '#6686',
        placedAt: '2026-07-28T00:00:00Z',
        ageDays: 12,
        status: { payment: 'PAID' },
        delivery: { tracking: [] }
      },
      signals: { isPaid: true }
    }
  });
  assert.ok(composed.includes('## Commande concernée'));
  assert.ok(composed.includes('Commande #6686'));
  // The raw bundle would have carried these keys through JSON.stringify.
  assert.ok(!composed.includes('"signals"'));
  assert.ok(!composed.includes('placedAt'));
});

// --- the requester -----------------------------------------------------------

test('the name travels and nothing else about the sender does', () => {
  const composed = composeDraftingMessage({
    message: MESSAGE,
    caseFile: caseFileFromRow(ROW),
    ticket: { requester_name: 'Laurence Guigue', requester_email_hash: 'abc', level: 2 }
  });
  assert.ok(composed.includes('Laurence Guigue'));
  assert.ok(!composed.includes('abc'));
});

// --- the answer schema -------------------------------------------------------

test('the schema makes the body a field rather than something to strip', () => {
  // A free completion arrives wrapped — « Voici la réponse : », a trailing note,
  // sometimes a markdown fence — and a stripper that guesses wrong mangles the
  // reply.
  assert.deepEqual(DRAFT_SCHEMA.required, ['subject', 'body']);
  assert.equal(DRAFT_SCHEMA.additionalProperties, false);
  assert.deepEqual(DRAFT_SCHEMA.properties.subject.type, ['string', 'null']);
});

// --- what is recorded about the call -----------------------------------------

test('the prompt inputs are ids and counts, never the content again', () => {
  const inputs = promptInputs({
    caseFile: caseFileFromRow(ROW),
    orderContext: null,
    investigationId: 'investigation-1',
    model: 'gpt-4o'
  });
  assert.equal(inputs.investigation_id, 'investigation-1');
  assert.equal(inputs.established_count, 1);
  assert.deepEqual(inputs.knowledge_titles, ['Délais de préparation']);
  assert.equal(inputs.order_context, false);
  // The claims themselves stay in the row this points at.
  assert.ok(!JSON.stringify(inputs).includes('en préparation'));
});

test('it records which fields were asked for, so a reworded draft is traceable', () => {
  const inputs = promptInputs({
    caseFile: caseFileFromRow({ ...ROW, missing: [{ field: 'purchase_email' }] }),
    investigationId: 'i',
    model: 'gpt-4o'
  });
  assert.deepEqual(inputs.missing_fields, ['purchase_email']);
});

// --- the rule's wording reaching the prompt ----------------------------------

test('a matched rule reaches the case file as guidance, and nothing else does', () => {
  // ONE FIELD OUT OF `exemplar_match`, NAMED. That column also carries the
  // similarity, the margin, the runner-up and every finding the run resolved —
  // diagnostics for a person, none of which a customer's reply has a use for.
  const caseFile = caseFileFromRow({
    verdict: 'answerable',
    established: [],
    exemplar_match: {
      exemplar_key: 'O-13',
      similarity: 0.71,
      margin: 0.09,
      runner_up: 'O-14',
      policy: {
        answer_key: 'annulation_trop_tard',
        answer_skeleton: 'La commande est déjà partie.',
        route: null,
        findings: { order_state: 'dispatched' }
      }
    }
  });

  assert.equal(caseFile.answerSkeleton, 'La commande est déjà partie.');
  assert.ok(!('exemplarMatch' in caseFile), 'the diagnostic must not travel whole');
  assert.ok(!JSON.stringify(caseFile).includes('0.71'), 'nor any part of it');
});

test('no rule, no skeleton — and never an empty string', () => {
  assert.equal(caseFileFromRow({ verdict: 'needs_human' }).answerSkeleton, null);
  assert.equal(
    caseFileFromRow({ verdict: 'needs_human', exemplar_match: { policy: { answer_skeleton: '   ' } } })
      .answerSkeleton,
    null
  );
});

test('the skeleton is framed as an instruction, never as a reply', () => {
  // THE FRAMING IS THE LOAD-BEARING PART. Told to "follow this", a model returns
  // the skeleton with a greeting bolted on; told it is an internal instruction
  // about the shape of a reply, it writes one. A skeleton is shared across
  // situations by design, so sending it as text would give different customers
  // the same reply.
  const prompt = composeDraftingMessage({
    message: { subject: 'Annulation', body_text: 'Je souhaite annuler ma commande.' },
    caseFile: {
      verdict: 'answerable',
      established: [],
      unverified: [],
      missing: [],
      doNotClaim: [],
      knowledge: [],
      answerSkeleton: 'La commande est déjà partie et ne peut plus être annulée.'
    }
  });

  assert.match(prompt, /## Ce que cette réponse doit faire/);
  assert.match(prompt, /jamais être recopié tel quel/);
  assert.ok(prompt.includes('La commande est déjà partie et ne peut plus être annulée.'));
});

test('the guidance sits after the facts, not before them', () => {
  // A model handed an instruction about shape before the evidence tends to
  // answer the instruction. Same reason the customer's own words come first.
  const prompt = composeDraftingMessage({
    message: { subject: 'x', body_text: 'y' },
    caseFile: {
      verdict: 'answerable',
      established: [],
      unverified: [],
      missing: [],
      doNotClaim: [],
      knowledge: [],
      answerSkeleton: 'consigne'
    }
  });
  assert.ok(prompt.indexOf('# Message du client') < prompt.indexOf('Ce que cette réponse doit faire'));
  assert.ok(prompt.indexOf('# Dossier') < prompt.indexOf('Ce que cette réponse doit faire'));
});

test('no skeleton leaves the prompt exactly as it was', () => {
  const prompt = composeDraftingMessage({
    message: { subject: 'x', body_text: 'y' },
    caseFile: { verdict: 'answerable', established: [], unverified: [], missing: [], doNotClaim: [], knowledge: [] }
  });
  assert.ok(!prompt.includes('Ce que cette réponse doit faire'));
});

// --- the code a rule hands out ------------------------------------------------

const OFFER_ROW = {
  verdict: 'answerable',
  established: [{ claim: 'x' }],
  exemplar_match: { policy: { offer_code: 'QIRINESS20', answer_skeleton: 'Donner le code.' } }
};

test('a rule’s code reaches the prompt as a literal to reproduce', () => {
  // A DISCOUNT CODE IS THE ONE THING IN A REPLY A MODEL MUST NEVER COMPOSE. It
  // looks like a word and it is a key, so an invented one is indistinguishable
  // from a real one until the customer types it in at checkout. Naming it in the
  // prompt is what makes "do not invent a code" enforceable.
  const message = composeDraftingMessage({
    message: { subject: 'Code', body_text: 'Je n’ai jamais reçu mon code.' },
    caseFile: caseFileFromRow(OFFER_ROW),
    offerableCodes: new Set(['QIRINESS20'])
  });

  assert.match(message, /## Code à communiquer au client/);
  assert.match(message, /QIRINESS20/);
  assert.match(message, /sans le modifier ni en inventer un autre/);
});

test('a code that has stopped being offerable is dropped, not sent stale', () => {
  // `promotions` is rewritten by the Shopify sync, so a code chosen months ago
  // may since have expired or been taken off the offerable list. The rest of the
  // rule is still right, so the offer goes and the reply is written without it —
  // the same treatment an unset parameter gets.
  const warnings = [];
  const message = composeDraftingMessage({
    message: { subject: 'Code', body_text: 'Je n’ai jamais reçu mon code.' },
    caseFile: caseFileFromRow(OFFER_ROW),
    offerableCodes: new Set(['AUTRECODE']),
    logger: { warn: (event, fields) => warnings.push([event, fields]) }
  });

  assert.ok(!message.includes('QIRINESS20'));
  assert.ok(!message.includes('Code à communiquer'));
  assert.deepEqual(warnings, [['draft.offer_code_dropped', { code: 'QIRINESS20' }]]);
});

test('no offerable codes at all drops every offer', () => {
  // The default. A caller that has not wired the lookup sends no code rather
  // than one nobody checked — a reply missing an offer is incomplete, a reply
  // carrying a dead code is a customer typing it in and writing back.
  const message = composeDraftingMessage({
    message: { subject: 'Code', body_text: 'Je n’ai jamais reçu mon code.' },
    caseFile: caseFileFromRow(OFFER_ROW)
  });
  assert.ok(!message.includes('QIRINESS20'));
});

test('a rule offering nothing adds no code section', () => {
  const message = composeDraftingMessage({
    message: { subject: 'Code', body_text: 'Bonjour' },
    caseFile: caseFileFromRow({ verdict: 'answerable', established: [{ claim: 'x' }] }),
    offerableCodes: new Set(['QIRINESS20'])
  });
  assert.ok(!message.includes('Code à communiquer'));
});

// --- the article a rule pins -------------------------------------------------

const PINNED_ROW = {
  ...ROW,
  exemplar_match: {
    policy: { knowledge_document_id: 'doc-1', answer_skeleton: 'Répondre sur le pays nommé.' }
  }
};
const ARTICLES = new Map([['doc-1', { title: 'Livraisons et retours', text: 'Nous livrons en Belgique.' }]]);

test('a pinned article reaches the prompt under its own heading', () => {
  // NOT inside « Base de connaissances approuvée ». That section is what
  // retrieval scored and cleared; this one is what a person chose. Same library,
  // different provenance, and a reply written from the wrong assumption about
  // which is which is a different kind of mistake.
  const composed = composeDraftingMessage({
    message: MESSAGE,
    caseFile: caseFileFromRow(PINNED_ROW),
    pinnedArticles: ARTICLES
  });

  assert.ok(composed.includes('## Article de référence pour cette situation'));
  assert.ok(composed.includes('Nous livrons en Belgique.'));
  const pinnedAt = composed.indexOf('## Article de référence');
  const retrievedAt = composed.indexOf('## Base de connaissances approuvée');
  assert.ok(retrievedAt !== -1 && pinnedAt !== -1 && retrievedAt < pinnedAt, 'two sections, not one');
});

test('an article that is no longer approved is dropped and logged', () => {
  // The loader only carries approved, undeleted documents, so "absent from the
  // map" IS "no longer usable" — the same treatment an offer code gets when it
  // stops being offerable.
  const warnings = [];
  const composed = composeDraftingMessage({
    message: MESSAGE,
    caseFile: caseFileFromRow(PINNED_ROW),
    pinnedArticles: new Map(),
    logger: { warn: (event, data) => warnings.push([event, data]) }
  });

  assert.ok(!composed.includes('## Article de référence pour cette situation'));
  assert.deepEqual(warnings, [['draft.pinned_article_dropped', { knowledgeDocumentId: 'doc-1' }]]);
});

test('a rule with no pin renders no heading at all', () => {
  const composed = composeDraftingMessage({
    message: MESSAGE,
    caseFile: caseFileFromRow(ROW),
    pinnedArticles: ARTICLES
  });
  assert.ok(!composed.includes('## Article de référence'));
});

test('an over-long article is capped rather than allowed to crowd out the case file', () => {
  const warnings = [];
  const long = 'a'.repeat(20000);
  const composed = composeDraftingMessage({
    message: MESSAGE,
    caseFile: caseFileFromRow(PINNED_ROW),
    pinnedArticles: new Map([['doc-1', { title: 'CGV', text: long }]]),
    logger: { warn: (event, data) => warnings.push([event, data]) }
  });

  assert.ok(composed.includes('## Article de référence pour cette situation'));
  assert.ok(!composed.includes(long), 'the whole 20k did not travel');
  assert.equal(warnings[0][0], 'draft.pinned_article_truncated');
});

test('the pinned id is read by name, never spread from the diagnostics beside it', () => {
  const caseFile = caseFileFromRow(PINNED_ROW);
  assert.equal(caseFile.knowledgeDocumentId, 'doc-1');
  assert.equal(caseFileFromRow(ROW).knowledgeDocumentId, null);
});

// --- the thread the reply continues ------------------------------------------

const TRIGGER = { id: 'm3', subject: 'Où est ma commande ?', body_text: 'toujours rien reçu' };

test('with no earlier mail the prompt is exactly what it was before history existed', () => {
  // 133 of 172 tickets are one message with no reply. Their prompt must not move
  // to fix the 39 that are not.
  const withEmpty = composeDraftingMessage({ message: TRIGGER, caseFile: caseFileFromRow(ROW), conversation: [] });
  const without = composeDraftingMessage({ message: TRIGGER, caseFile: caseFileFromRow(ROW) });

  assert.equal(withEmpty, without);
  assert.ok(!withEmpty.includes('Ce que nous avons déjà répondu'));
});

test('our own earlier replies reach the prompt, above the new message', () => {
  const prompt = composeDraftingMessage({
    message: TRIGGER,
    caseFile: caseFileFromRow(ROW),
    conversation: [
      { id: 'm1', direction: 'inbound', body_text: 'ma commande n’arrive pas', received_at: '2026-08-01T09:00:00Z' },
      { id: 'm2', direction: 'outbound', body_text: 'Nous relançons le transporteur et revenons vers vous.', received_at: '2026-08-02T09:00:00Z' },
      TRIGGER
    ]
  });

  assert.ok(prompt.includes('Nous relançons le transporteur'));
  assert.ok(prompt.includes('ma commande n’arrive pas'));
  // Read before the new message, so it is interpreted as an answer to us.
  assert.ok(prompt.indexOf('Nous relançons le transporteur') < prompt.indexOf('# Message du client'));
  // And the trigger is printed once, whole, in its own section.
  assert.equal(prompt.split('toujours rien reçu').length - 1, 1);
});

test('a quoted reply chain inside our own mail is stripped, not shown back', () => {
  const prompt = composeDraftingMessage({
    message: TRIGGER,
    caseFile: caseFileFromRow(ROW),
    conversation: [
      {
        id: 'm2',
        direction: 'outbound',
        body_text: 'Pouvez-vous nous confirmer votre adresse ?\n\nLe 1 août 2026, client a écrit :\n> ma commande n’arrive pas',
        received_at: '2026-08-02T09:00:00Z'
      },
      TRIGGER
    ]
  });

  assert.ok(prompt.includes('confirmer votre adresse'));
  assert.ok(!prompt.includes('> ma commande n’arrive pas'));
});

// --- where the case stands ----------------------------------------------------

test('with no case state the prompt is exactly what it was', () => {
  const withNull = composeDraftingMessage({ message: TRIGGER, caseFile: caseFileFromRow(ROW), caseState: null });
  const without = composeDraftingMessage({ message: TRIGGER, caseFile: caseFileFromRow(ROW) });
  assert.equal(withNull, without);
  assert.ok(!withNull.includes('Où en est ce dossier'));
});

test('a reading with nothing outstanding renders no block', () => {
  const prompt = composeDraftingMessage({
    message: TRIGGER,
    caseFile: caseFileFromRow(ROW),
    caseState: { resolved_inputs: [], pending_customer_inputs: [], commitments: [] }
  });
  assert.ok(!prompt.includes('Où en est ce dossier'));
});

test('what the customer already supplied is named, so it cannot be asked for twice', () => {
  const prompt = composeDraftingMessage({
    message: TRIGGER,
    caseFile: caseFileFromRow(ROW),
    caseState: {
      resolved_inputs: ['shopify_order_number'],
      pending_customer_inputs: ['photo'],
      commitments: [
        { what: 'relancer le transporteur', status: 'pending' },
        { what: 'envoyer le remplacement', status: 'done' }
      ]
    }
  });

  assert.ok(prompt.includes('Où en est ce dossier'));
  assert.ok(prompt.includes(MISSING_FIELDS.shopify_order_number.label));
  assert.ok(prompt.includes(MISSING_FIELDS.photo.label));
  // An open promise travels; one already honoured is not a thing to restate.
  assert.ok(prompt.includes('relancer le transporteur'));
  assert.ok(!prompt.includes('envoyer le remplacement'));
});

test('a key nothing recognises never reaches the prompt', () => {
  const prompt = composeDraftingMessage({
    message: TRIGGER,
    caseFile: caseFileFromRow(ROW),
    caseState: { resolved_inputs: ['invented_key'], pending_customer_inputs: [], commitments: [] }
  });
  assert.ok(!prompt.includes('invented_key'));
});

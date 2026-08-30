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

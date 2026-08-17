import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyAttachments,
  detectPhotoMention,
  summarisePhotoEvidence,
  toPromptText
} from './photo-evidence.mjs';

const image = (over = {}) => ({
  name: 'IMG_4821.jpg',
  contentType: 'image/jpeg',
  size: 2_400_000,
  isInline: false,
  ...over
});

// --- the customer's words ----------------------------------------------------

test('detects the French phrasings that actually appear in the corpus', () => {
  for (const body of [
    'Vous trouverez les photos ci-joint.',
    'Je vous envoie une pièce jointe.',
    'Voici des captures d’écran du problème.',
    'Le cliché montre bien la fissure.',
    'Je joins la photo du colis abîmé.'
  ]) {
    assert.equal(detectPhotoMention(body).mentioned, true, body);
  }
});

test('reports which term matched, so a false positive can be audited', () => {
  assert.equal(detectPhotoMention('Voici une capture d’écran').term, 'capture d’écran');
  assert.equal(detectPhotoMention('les photos sont jointes').term, 'photos');
});

test('an ordinary message mentions nothing', () => {
  assert.deepEqual(detectPhotoMention('Bonjour, ou en est ma commande ?'), {
    mentioned: false,
    term: null
  });
});

// --- what actually arrived ---------------------------------------------------

test('a CV is an attachment but never an image', () => {
  const summary = classifyAttachments([
    { name: 'CV_2026.pdf', contentType: 'application/pdf', size: 180_000 }
  ]);
  assert.equal(summary.images, 0);
  assert.equal(summary.nonImages, 1);
});

test('a signature logo is furniture, not evidence', () => {
  const summary = classifyAttachments([
    image({ name: 'logo.png', contentType: 'image/png', size: 8_000, isInline: true })
  ]);
  assert.equal(summary.images, 0);
  assert.equal(summary.furniture, 1);
});

test('a big inline image is evidence — a pasted photo is inline too', () => {
  const summary = classifyAttachments([image({ isInline: true, size: 3_000_000 })]);
  assert.equal(summary.images, 1);
});

test('Outlook placeholder names are furniture whatever their size', () => {
  const summary = classifyAttachments([
    image({ name: 'image001.png', contentType: 'image/png', size: 900_000, isInline: true })
  ]);
  assert.equal(summary.furniture, 1);
  assert.equal(summary.images, 0);
});

// --- the verdict -------------------------------------------------------------

test('a photo that arrived reads as attached', () => {
  const evidence = summarisePhotoEvidence([
    { direction: 'inbound', body_text: 'le flacon est cassé', has_attachments: true, attachments: [image()] }
  ]);
  assert.equal(evidence.outcome, 'attached');
  assert.equal(evidence.images, 1);
});

test('THE CASE THAT MATTERS: mentioned, nothing attached', () => {
  const evidence = summarisePhotoEvidence([
    { direction: 'inbound', body_text: 'Je vous joins la photo.', has_attachments: false, attachments: [] }
  ]);
  assert.equal(evidence.outcome, 'mentioned_not_attached');
  assert.equal(evidence.mentioned, true);
  assert.equal(evidence.images, 0);
});

test('an attachment with no metadata is unknown, never "no photo"', () => {
  // A row ingested before the Graph attachment fetch existed.
  const evidence = summarisePhotoEvidence([
    { direction: 'inbound', body_text: 'voir le fichier', has_attachments: true, attachments: null }
  ]);
  assert.equal(evidence.outcome, 'attachment_type_unknown');
  assert.equal(evidence.attachmentsKnown, false);
});

test('unknown beats mentioned — never tell a customer to resend what they may have sent', () => {
  const evidence = summarisePhotoEvidence([
    { direction: 'inbound', body_text: 'photos ci-joint', has_attachments: true, attachments: null }
  ]);
  assert.equal(evidence.outcome, 'attachment_type_unknown');
});

test('a CV alone is not a photo and not an unknown', () => {
  const evidence = summarisePhotoEvidence([
    {
      direction: 'inbound',
      body_text: 'Je postule au poste.',
      has_attachments: true,
      attachments: [{ name: 'CV.pdf', contentType: 'application/pdf', size: 120_000 }]
    }
  ]);
  assert.equal(evidence.outcome, 'none');
  assert.equal(evidence.nonImages, 1);
});

test('our own replies are not evidence the customer sent anything', () => {
  const evidence = summarisePhotoEvidence([
    { direction: 'outbound', body_text: 'Merci pour la photo.', has_attachments: true, attachments: [image()] }
  ]);
  assert.equal(evidence.outcome, 'none');
  assert.equal(evidence.images, 0);
});

test('evidence anywhere in the thread counts, not just the first message', () => {
  const evidence = summarisePhotoEvidence([
    { direction: 'inbound', body_text: 'mon flacon est cassé', has_attachments: false, attachments: [] },
    { direction: 'inbound', body_text: 'voici', has_attachments: true, attachments: [image()] }
  ]);
  assert.equal(evidence.outcome, 'attached');
});

test('no messages at all is "none", not a crash', () => {
  assert.equal(summarisePhotoEvidence([]).outcome, 'none');
  assert.equal(summarisePhotoEvidence(undefined).outcome, 'none');
});

// --- what the model is shown -------------------------------------------------

test('the prompt line never invents an instruction to ask for a photo', () => {
  for (const outcome of ['attached', 'mentioned_not_attached', 'attachment_type_unknown', 'none']) {
    const text = toPromptText({ outcome, images: 1, nonImages: 0, matchedTerm: 'photo' });
    assert.match(text, /^Preuve photo/);
    assert.doesNotMatch(text, /demande|demandez/i);
  }
});

test('the unknown case says so in words, rather than reporting zero', () => {
  const text = toPromptText({ outcome: 'attachment_type_unknown' });
  assert.match(text, /type n’a pas été enregistré/);
});

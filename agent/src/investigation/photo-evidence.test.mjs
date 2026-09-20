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

test('an UNFLAGGED message with no metadata is not_checked, never "no photo"', () => {
  // THE REGRESSION THIS FILE EXISTS FOR. Exchange reports `hasAttachments:
  // false` when the only attachment is inline, so an unflagged row with a null
  // `attachments` is not an empty message — it is a message nobody asked about.
  // Measured 2026-09-20 on ticket d48f1c08, whose 3.6 MB inline PNG this
  // function called `none` with `attachmentsKnown: true` for two months.
  const evidence = summarisePhotoEvidence([
    {
      direction: 'inbound',
      body_text: 'Buenas tardes, les adjunto foto de la caja y del contenido',
      has_attachments: false,
      attachments: null
    }
  ]);
  assert.equal(evidence.outcome, 'not_checked');
  assert.equal(evidence.attachmentsChecked, false);
});

test('not_checked outranks a mention: we cannot say a photo failed to arrive', () => {
  const evidence = summarisePhotoEvidence([
    { direction: 'inbound', body_text: 'voici la photo', has_attachments: false, attachments: null }
  ]);
  assert.equal(evidence.outcome, 'not_checked');
});

test('the two ignorances stay distinct — a flagged row is still type_unknown', () => {
  // Same null, different claim: the flag says something IS attached, so a person
  // is looking for a type we failed to record, not for whether anything came.
  const flagged = summarisePhotoEvidence([
    { direction: 'inbound', body_text: 'voir le fichier', has_attachments: true, attachments: null }
  ]);
  const unflagged = summarisePhotoEvidence([
    { direction: 'inbound', body_text: 'voir le fichier', has_attachments: false, attachments: null }
  ]);
  assert.equal(flagged.outcome, 'attachment_type_unknown');
  assert.equal(unflagged.outcome, 'not_checked');
  assert.notEqual(flagged.outcome, unflagged.outcome);
});

test('an empty array is a real answer: we asked, nothing was attached', () => {
  // The other half of the null's meaning. `[]` must keep resolving to `none`,
  // or the backfill could never close a row.
  const evidence = summarisePhotoEvidence([
    { direction: 'inbound', body_text: 'ma commande est en retard', has_attachments: false, attachments: [] }
  ]);
  assert.equal(evidence.outcome, 'none');
  assert.equal(evidence.attachmentsChecked, true);
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
  for (const outcome of ['attached', 'mentioned_not_attached', 'attachment_type_unknown', 'not_checked', 'none']) {
    const text = toPromptText({ outcome, images: 1, nonImages: 0, matchedTerm: 'photo' });
    assert.match(text, /^Preuve photo/);
    assert.doesNotMatch(text, /demande|demandez/i);
  }
});

test('the unknown case says so in words, rather than reporting zero', () => {
  const text = toPromptText({ outcome: 'attachment_type_unknown' });
  assert.match(text, /type n’a pas été enregistré/);
});

test('the not_checked line forbids the conclusion in both directions', () => {
  // It is shown to a model that will otherwise fill the gap itself. Saying only
  // "not verified" invites "no photo was received"; the line has to close both.
  const text = toPromptText({ outcome: 'not_checked' });
  assert.match(text, /jamais été relevées/);
  assert.match(text, /Ne rien conclure/);
});

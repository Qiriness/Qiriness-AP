import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyAttachments,
  listTicketAttachments,
  summarisePhotoEvidence,
  toPublicAttachments
} from './photo-evidence-rules.mjs';

// `listTicketAttachments` is what the ticket panel renders. The verdict half is
// covered by agent/src/investigation/photo-evidence.test.mjs, which still passes
// against this file through the agent's re-export; these tests are about the
// part that only the dashboard reads — which parts get NAMED to an operator.

const photo = (over = {}) => ({
  name: 'colis-abime.jpg',
  contentType: 'image/jpeg',
  size: 820_000,
  isInline: false,
  ...over
});

test('lists a real photo with the fields the panel shows', () => {
  const result = listTicketAttachments([
    { graph_message_id: 'AAMk-fake-message-id', direction: 'inbound', body_text: 'Voici la photo ci-jointe', has_attachments: true, attachments: [photo()] }
  ]);

  assert.equal(result.outcome, 'attached');
  // `messageId` and `partIndex` are the fetch handle the proxy resolves against;
  // they are asserted here because the dashboard's public mapping must STRIP
  // them, and a test that did not know they existed could not notice if the
  // Exchange id started reaching the browser.
  assert.deepEqual(result.images, [
    {
      name: 'colis-abime.jpg',
      contentType: 'image/jpeg',
      size: 820_000,
      messageId: 'AAMk-fake-message-id',
      partIndex: 0
    }
  ]);
  assert.equal(result.others.length, 0);
  assert.equal(result.furniture, 0);
});

test('furniture is counted, never listed', () => {
  const result = listTicketAttachments([
    {
      graph_message_id: 'AAMk-fake-message-id',
      direction: 'inbound',
      body_text: 'Bonjour',
      has_attachments: true,
      attachments: [
        photo(),
        // The signature logo the corpus is full of: matched on name.
        { name: 'image001.png', contentType: 'image/png', size: 30_000, isInline: true },
        // And the other half of the rule: a small inline image with an
        // innocuous name.
        { name: 'banner.png', contentType: 'image/png', size: 4_000, isInline: true }
      ]
    }
  ]);

  assert.equal(result.images.length, 1, 'only the real photo is named');
  assert.equal(result.images[0].name, 'colis-abime.jpg');
  assert.equal(result.furniture, 2);
});

test('a signature separated by an underscore is still furniture', () => {
  // The real one, off ticket 6ad65501: `\b` does not exist between `Signature`
  // and `_`, so a 12 KB non-inline signature image was listed as the customer's
  // photo and the case file read `photo_evidence: attached` with no photo on
  // the ticket. One part in the corpus's 115 changes with the lookahead.
  const result = listTicketAttachments([
    {
      graph_message_id: 'AAMk-fake-message-id',
      direction: 'inbound',
      body_text: 'Bonjour',
      has_attachments: true,
      attachments: [
        {
          name: 'Signature_6C20675392446.png',
          contentType: 'image/png',
          size: 12_000,
          isInline: false
        }
      ]
    }
  ]);

  assert.equal(result.images.length, 0);
  assert.equal(result.furniture, 1);
  assert.equal(result.outcome, 'none');
});

test('the lookahead does not eat a real photo that starts with the same letters', () => {
  // The other side of the change: `signature` as a prefix of a longer WORD is
  // not furniture, or a customer photographing a signed delivery note loses it.
  const result = listTicketAttachments([
    {
      graph_message_id: 'AAMk-fake-message-id',
      direction: 'inbound',
      body_text: '',
      has_attachments: true,
      attachments: [
        { name: 'signatures-bon-de-livraison.jpg', contentType: 'image/jpeg', size: 900_000, isInline: false }
      ]
    }
  ]);

  assert.equal(result.images.length, 1);
  assert.equal(result.furniture, 0);
});

test('the two readers of the furniture rule agree', () => {
  // The reason the rule was extracted: `classifyAttachments` counting a part as
  // furniture while the list rendered it as a photo is the drift that would put
  // a logo in front of an operator as a customer's evidence.
  const parts = [
    photo(),
    { name: 'image001.png', contentType: 'image/png', size: 30_000, isInline: true },
    { name: 'logo.png', contentType: 'image/png', size: 900_000, isInline: false },
    { name: 'catalogue.pdf', contentType: 'application/pdf', size: 400_000, isInline: false }
  ];

  const classified = classifyAttachments(parts);
  const listed = listTicketAttachments([
    { graph_message_id: 'AAMk-fake-message-id', direction: 'inbound', body_text: '', has_attachments: true, attachments: parts }
  ]);

  assert.equal(listed.images.length, classified.images);
  assert.equal(listed.furniture, classified.furniture);
  assert.equal(listed.others.length, classified.nonImages);
});

test('non-images are listed separately — a CV is not a photo', () => {
  const result = listTicketAttachments([
    {
      graph_message_id: 'AAMk-fake-message-id',
      direction: 'inbound',
      body_text: 'Candidature spontanée',
      has_attachments: true,
      attachments: [{ name: 'CV.pdf', contentType: 'application/pdf', size: 120_000, isInline: false }]
    }
  ]);

  assert.equal(result.images.length, 0);
  assert.deepEqual(result.others, [
    {
      name: 'CV.pdf',
      contentType: 'application/pdf',
      size: 120_000,
      messageId: 'AAMk-fake-message-id',
      partIndex: 0
    }
  ]);
  assert.equal(result.outcome, 'none');
});

test('the desk’s own replies are not the customer’s evidence', () => {
  const result = listTicketAttachments([
    { graph_message_id: 'AAMk-fake-message-id', direction: 'inbound', body_text: 'Bonjour', has_attachments: false, attachments: [] },
    {
      direction: 'outbound',
      body_text: 'Voici votre facture ci-jointe',
      has_attachments: true,
      attachments: [photo({ name: 'facture.jpg' })]
    }
  ]);

  assert.equal(result.images.length, 0, 'an outbound attachment is ours, not theirs');
  assert.equal(result.mentioned, false, 'and neither is our own wording');
});

test('a mentioned photo that never arrived reports the term that matched', () => {
  const result = listTicketAttachments([
    {
      graph_message_id: 'AAMk-fake-message-id',
      direction: 'inbound',
      body_text: 'Vous trouverez les photos ci-jointes du produit',
      has_attachments: false,
      attachments: []
    }
  ]);

  assert.equal(result.outcome, 'mentioned_not_attached');
  assert.equal(result.mentioned, true);
  // `ci-jointes` and not `photos`: PHOTO_TERMS is ordered most-specific first so
  // the term reported is the strongest evidence in the sentence, not whichever
  // matched leftmost. The panel shows this term to the operator, so which one
  // wins is a display decision and worth pinning.
  assert.equal(result.matchedTerm, 'ci-jointes');
  assert.equal(result.images.length, 0);
});

test('a flagged message with no metadata is unknown, not empty', () => {
  // NULL means nobody asked Graph. Rendering that as "no photo attached" would
  // tell an operator the customer sent nothing, about a message whose own flag
  // says otherwise.
  const result = listTicketAttachments([
    { graph_message_id: 'AAMk-fake-message-id', direction: 'inbound', body_text: 'ci-joint', has_attachments: true, attachments: null }
  ]);

  assert.equal(result.known, false);
  assert.equal(result.outcome, 'attachment_type_unknown');
  assert.equal(result.images.length, 0);
});

test('arrival order is preserved across messages', () => {
  const result = listTicketAttachments([
    {
      graph_message_id: 'AAMk-fake-message-id',
      direction: 'inbound',
      body_text: 'photo 1',
      has_attachments: true,
      attachments: [photo({ name: 'un.jpg' }), photo({ name: 'deux.jpg' })]
    },
    {
      graph_message_id: 'AAMk-fake-message-id',
      direction: 'inbound',
      body_text: 'et la suite',
      has_attachments: true,
      attachments: [photo({ name: 'trois.jpg' })]
    }
  ]);

  assert.deepEqual(
    result.images.map((image) => image.name),
    ['un.jpg', 'deux.jpg', 'trois.jpg']
  );
});

test('the panel and the case file cannot disagree about the verdict', () => {
  const messages = [
    { graph_message_id: 'AAMk-fake-message-id', direction: 'inbound', body_text: 'la photo ci-jointe', has_attachments: true, attachments: [photo()] }
  ];

  assert.equal(listTicketAttachments(messages).outcome, summarisePhotoEvidence(messages).outcome);
});

test('no messages is not a crash', () => {
  const result = listTicketAttachments([]);
  assert.deepEqual(result.images, []);
  assert.deepEqual(result.others, []);
  assert.equal(result.outcome, 'none');
});

// --------------------------------------------------------- the public boundary

const ticketMessages = () => [
  {
    graph_message_id: 'AAMkADVhOWFjMDUxLWEXCHANGE-ITEM-ID',
    direction: 'inbound',
    body_text: 'la photo ci-jointe',
    has_attachments: true,
    attachments: [
      photo(),
      { name: 'CV.pdf', contentType: 'application/pdf', size: 120_000, isInline: false }
    ]
  }
];

test('the Exchange message id never reaches the browser', () => {
  // THE ONE THAT MATTERS. The dashboard has no authentication yet, so anything
  // this returns is readable by anyone who can open the page — and a mailbox
  // item id is a durable, unguessable handle to one customer's email. If this
  // assertion ever fails, the panel is publishing it in its own page source.
  const listed = listTicketAttachments(ticketMessages());
  const published = toPublicAttachments('ticket-abc', listed);

  assert.ok(listed.images[0].messageId, 'the server-side list must still carry the handle');

  const serialised = JSON.stringify(published);
  assert.ok(!serialised.includes('AAMkADVhOWFjMDUxLWEXCHANGE-ITEM-ID'), 'the id crossed');
  assert.ok(!serialised.includes('messageId'), 'the field crossed');
  assert.ok(!serialised.includes('partIndex'), 'the offset crossed');
});

test('an image gets a same-origin path and a non-image gets nothing', () => {
  const published = toPublicAttachments('ticket-abc', listTicketAttachments(ticketMessages()));

  assert.equal(published.images[0].src, '/api/tickets/ticket-abc/attachments/0');
  assert.equal(published.others[0].src, null, 'the proxy serves images only');
});

test('the index in the path is the position the proxy will re-derive', () => {
  // The whole authorisation model: the browser sends an offset into this list,
  // and the service rebuilds the same list to resolve it. A path pointing at a
  // different entry than the one rendered beside it would show one customer's
  // photo under another's caption.
  const messages = [
    {
      graph_message_id: 'AAMk-1',
      direction: 'inbound',
      body_text: '',
      has_attachments: true,
      attachments: [
        { name: 'image001.png', contentType: 'image/png', size: 30_000, isInline: true },
        photo({ name: 'premiere.jpg' }),
        photo({ name: 'seconde.jpg' })
      ]
    }
  ];
  const published = toPublicAttachments('t', listTicketAttachments(messages));

  // The furniture part is not in `images`, so the first photo is index 0 — not
  // index 1, which is where it sits in the raw attachment array.
  assert.equal(published.images[0].name, 'premiere.jpg');
  assert.equal(published.images[0].src, '/api/tickets/t/attachments/0');
  assert.equal(published.images[1].name, 'seconde.jpg');
  assert.equal(published.images[1].src, '/api/tickets/t/attachments/1');
});

test('a ticket id with a slash cannot escape the path', () => {
  const published = toPublicAttachments('../../secrets', listTicketAttachments(ticketMessages()));
  assert.equal(published.images[0].src, '/api/tickets/..%2F..%2Fsecrets/attachments/0');
});

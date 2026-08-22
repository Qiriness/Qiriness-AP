import assert from 'node:assert/strict';
import test from 'node:test';

import { identityFromPayload, runContactFormRepair } from './contact-form-repair.mjs';

const MAILBOX = 'contact@qiriness.com';

const ROW = {
  id: 'message-1',
  graph_message_id: 'AAMkAGI1',
  subject: 'RE: Nouveau message de client',
  from_email: 'delph-al@hotmail.fr',
  from_name: 'Delphine CADORET',
  body_text: "Bonjour, je n'ai pas reçu mon code de -20%.",
  raw_graph_payload: {
    contactForm: { envelopeFrom: { name: 'contact', address: MAILBOX } }
  }
};

/** The reply as Graph still holds it — our text, our envelope. */
const RAW = {
  id: 'AAMkAGI1',
  conversationId: 'CONV1',
  from: { emailAddress: { name: 'contact', address: MAILBOX } },
  subject: 'RE: Nouveau message de client',
  receivedDateTime: '2026-07-27T10:00:00Z',
  body: { contentType: 'text', content: 'Bonjour Delphine, votre code arrive.' }
};

function store(rows = [ROW]) {
  const saved = [];
  return {
    saved,
    async pending() {
      return rows;
    },
    async save(id, patch) {
      saved.push({ id, patch });
    }
  };
}

test('the true sender is read from the envelope recorded at ingestion', () => {
  assert.deepEqual(identityFromPayload(ROW), { from_email: MAILBOX, from_name: 'contact' });
});

test('a row with no recorded envelope is left alone rather than guessed at', () => {
  // A wrong sender written confidently is worse than the wrong sender already
  // there, because the second is detectable and the first is not.
  assert.equal(identityFromPayload({ raw_graph_payload: {} }), null);
  assert.equal(identityFromPayload({}), null);
  assert.equal(identityFromPayload(null), null);
});

test('identity is repaired without any Graph call', async () => {
  const s = store();
  const totals = await runContactFormRepair({
    store: s,
    mailbox: MAILBOX,
    shopId: 'shop-1',
    identityOnly: true
  });

  assert.equal(totals.identityFixed, 1);
  assert.equal(totals.bodyRecovered, 0);
  assert.equal(s.saved[0].patch.from_email, MAILBOX);
  // The body is untouched: it is not recoverable without the mailbox, and
  // writing anything here would be inventing a reply.
  assert.ok(!('body_text' in s.saved[0].patch));
});

test('the reply body is recovered and replaces the customer text', async () => {
  const s = store();
  const totals = await runContactFormRepair({
    store: s,
    graphClient: { async getMessage() { return RAW; } },
    mailbox: MAILBOX,
    shopId: 'shop-1'
  });

  assert.equal(totals.bodyRecovered, 1);
  assert.match(s.saved[0].patch.body_text, /Bonjour Delphine, votre code arrive/);
  assert.doesNotMatch(s.saved[0].patch.body_text, /code de -20%/);
  assert.equal(s.saved[0].patch.from_email, MAILBOX);
});

test('a message that has left the mailbox still gets its sender back', async () => {
  const s = store();
  const totals = await runContactFormRepair({
    store: s,
    graphClient: { async getMessage() { return null; } },
    mailbox: MAILBOX,
    shopId: 'shop-1'
  });

  assert.equal(totals.missing, 1);
  assert.equal(totals.identityFixed, 1);
  assert.equal(s.saved[0].patch.from_email, MAILBOX);
  assert.ok(!('body_text' in s.saved[0].patch));
});

test('a genuine Shopify notification is refused, not "repaired"', async () => {
  // THE GUARD AGAINST UNDOING THE FEATURE. 96 of the 148 parsed messages really
  // did arrive from Shopify's mailer, and their swapped identity is correct. If
  // the fixed mapper still parses a form, the envelope IS the relay and this row
  // was never broken — rewriting it would put Shopify's address on a ticket that
  // is genuinely about a customer.
  const s = store();
  const totals = await runContactFormRepair({
    store: s,
    graphClient: {
      async getMessage() {
        return {
          ...RAW,
          from: { emailAddress: { name: 'Qiriness (Shopify)', address: 'mailer@shopify.com' } },
          body: {
            contentType: 'text',
            content:
              'formulaire de contact\n\nName:\n\nDelphine CADORET\n\nE-mail:\n\ndelph-al@hotmail.fr\n\nCorps:\n\nBonjour'
          }
        };
      }
    },
    mailbox: MAILBOX,
    shopId: 'shop-1'
  });

  assert.equal(totals.failed, 1);
  assert.equal(s.saved.length, 0);
});

test('a dry run writes nothing but still reports what it would do', async () => {
  const s = store();
  const totals = await runContactFormRepair({
    store: s,
    graphClient: { async getMessage() { return RAW; } },
    mailbox: MAILBOX,
    shopId: 'shop-1',
    dryRun: true
  });

  assert.equal(totals.bodyRecovered, 1);
  assert.equal(s.saved.length, 0);
});

test('it refuses to run without the mailbox it needs to resolve direction', async () => {
  // Without it every message re-maps as inbound and the parse this repairs
  // would fire again on the repaired row.
  await assert.rejects(
    () => runContactFormRepair({ store: store(), shopId: 'shop-1', identityOnly: true }),
    /support mailbox/
  );
});

test('body recovery without a graph client is refused rather than silently skipped', async () => {
  await assert.rejects(
    () => runContactFormRepair({ store: store(), mailbox: MAILBOX, shopId: 'shop-1' }),
    /graphClient/
  );
});

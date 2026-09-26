import assert from 'node:assert/strict';
import test from 'node:test';

import { renderReviewPage } from './casework-review-page.mjs';

const page = renderReviewPage({
  generatedAt: '2026-09-26T00:00:00.000Z',
  threads: [
    {
      ticketId: 't1',
      subject: 'Colis </script><b>x</b>',
      category: 'delivery',
      group: 'other_sender',
      messages: [{ id: 'm1', direction: 'inbound', roleName: 'client', actor: 'customer', at: null, own: 'hi', quoted: '' }],
      cuts: []
    }
  ]
});

test('the page script parses', () => {
  const script = page.match(/<script>([\s\S]*)<\/script>\s*<\/body>/)[1];
  assert.doesNotThrow(() => new Function(script));
});

test('the data block carries the stage 3 vocabulary, and no mail can close the script early', () => {
  const json = page.match(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/)[1];
  const data = JSON.parse(json);
  assert.deepEqual(Object.keys(data.vocab.obligationOwners), ['support', 'colleague', 'partner']);
  assert.deepEqual(Object.keys(data.vocab.nextActors), ['customer', 'support', 'colleague', 'partner', 'nobody']);
  assert.ok(data.vocab.requiredByDirection.outbound.includes('nextActor'));
  assert.equal(data.threads[0].subject, 'Colis </script><b>x</b>');
});

test('the page carries the current label schema: the five added questions, the broader photo wording, the holding reply', () => {
  const json = page.match(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/)[1];
  const data = JSON.parse(json);
  assert.equal(data.labelSchemaVersion, 4);
  assert.ok('holding_reply' in data.vocab.nextActions);
  for (const key of ['postal_address', 'preferred_remedy', 'receipt_confirmation', 'skin_type', 'skin_concern']) {
    assert.ok(key in data.vocab.customerQuestions, key);
  }
  assert.equal(data.vocab.customerQuestions.photo, 'la photo demandée (produit ou zone concernée)');
  assert.match(page, /labelSchemaVersion: DATA\.labelSchemaVersion/);
});

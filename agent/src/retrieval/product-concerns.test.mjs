import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONCERNS,
  CONCERN_KEYS,
  READABLE_CONCERNS,
  concernsInText,
  productMatchesConcern,
  tagsForConcern,
  unclassifiedSkinTags
} from './product-concerns.mjs';

test('a customer’s words resolve to the concerns the catalogue is tagged with', () => {
  // THE JOIN THIS FILE EXISTS FOR. « peaux sensibles » is a tag nobody writes in
  // an email and « ma peau tiraille » is an email nobody tags a product with.
  assert.deepEqual(concernsInText('Quel produit pour une peau sensible ?'), ['sensitive']);
  assert.deepEqual(concernsInText('ma peau tiraille beaucoup en hiver'), ['dry']);
  assert.deepEqual(concernsInText('je cherche quelque chose contre les rides'), ['mature']);
});

test('several concerns in one message all come back', () => {
  // Skin is not one thing and the catalogue is tagged the same way. Answering
  // only the first concern answers half the question.
  assert.deepEqual(concernsInText('j’ai la peau très sèche et réactive'), ['sensitive', 'dry']);
  assert.deepEqual(concernsInText('peau mixte à tendance grasse'), ['oily', 'combination']);
});

test('accents are not required of a customer', () => {
  assert.deepEqual(concernsInText('ma peau est deshydratee'), ['dry']);
  assert.deepEqual(concernsInText('ma peau est déshydratée'), ['dry']);
});

test('a cue never fires on a fragment of another word', () => {
  // Substring matching put `sensitive` on « insensible », which is the opposite
  // meaning — hence the word boundaries.
  assert.deepEqual(concernsInText('je suis insensible au froid'), []);
  assert.deepEqual(concernsInText('bonjour, avez-vous ce produit en stock ?'), []);
});

test('nothing resolves to `all_types` from a message', () => {
  // It is a catalogue tag, not a thing a customer says about themselves — it
  // exists so a product suiting every skin type is returnable for any concern.
  assert.ok(!READABLE_CONCERNS.includes('all_types'));
  assert.equal(CONCERNS.all_types.cues.length, 0);
  for (const key of CONCERN_KEYS) {
    for (const cue of CONCERNS[key].cues) {
      assert.ok(!concernsInText(cue).includes('all_types'), `${cue} reached all_types`);
    }
  }
});

test('a product for all skin types is returned for a specific concern', () => {
  // The merchandiser's own inference, not ours: a product labelled as suiting
  // every skin type suits a sensitive one. Excluding it would refuse dozens of
  // products to every question.
  assert.ok(productMatchesConcern(['tous les types de peaux'], 'sensitive'));
  assert.ok(productMatchesConcern(['peaux sensibles'], 'sensitive'));
  assert.ok(!productMatchesConcern(['peaux grasses'], 'sensitive'));
  // …but `all_types` itself does not collect every other concern's products.
  assert.ok(!productMatchesConcern(['peaux sensibles'], 'all_types'));
});

test('every readable concern has tags behind it', () => {
  // A concern with no tags is a rule that can never return a product — the list
  // is bounded by what the merchandising distinguishes, not by what a customer
  // might mention.
  for (const key of READABLE_CONCERNS) {
    assert.ok(tagsForConcern(key).length > 0, `${key} has no catalogue tags`);
  }
});

test('the reconcile flags a new skin tag and ignores the marketing ones', () => {
  // THE POINT OF THE RECONCILE. Tags arrive with every product sync, so a new
  // skin-type tag appearing next season is a concern the agent would silently
  // fail to match. Scoped to the skin family: this catalogue carries 190 tags
  // and a list of all the unclassified ones is a list nobody reads.
  const flagged = unclassifiedSkinTags([
    'peaux sensibles',
    'peaux sèches',
    'peaux déshydratées',
    'Relaxant',
    'éclat',
    'routine'
  ]);
  assert.deepEqual(flagged, ['peaux déshydratées']);
});

test('a variant spelling already in the vocabulary is not flagged as new', () => {
  // `peaux sèche` is a real tag on this catalogue and is listed under `dry`.
  // Flagging it would put permanent noise in the report.
  assert.deepEqual(unclassifiedSkinTags(['peaux sèche', 'peau mature', 'peaux mixte']), []);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_LINK_LABEL,
  findLinkMarkers,
  isReplyLinkUrl,
  normaliseReplyLink,
  splitLinkMarkers
} from './reply-link.mjs';

const LINK = { url: 'https://example.com/guide', label: 'le guide d’utilisation' };

test('only a full https address with a real host is a link', () => {
  assert.equal(isReplyLinkUrl('https://example.com/a?b=c'), true);
  assert.equal(isReplyLinkUrl('http://example.com'), false);
  assert.equal(isReplyLinkUrl('javascript:alert(1)'), false);
  assert.equal(isReplyLinkUrl('https://localhost'), false);
  assert.equal(isReplyLinkUrl('https://example.com/a b'), false);
  assert.equal(isReplyLinkUrl(''), false);
});

test('a link needs both halves, and a short description', () => {
  assert.deepEqual(normaliseReplyLink({ url: ' https://example.com ', label: ' la page ' }), {
    url: 'https://example.com',
    label: 'la page'
  });
  assert.equal(normaliseReplyLink({ url: 'https://example.com', label: '' }), null);
  assert.equal(normaliseReplyLink({ url: '', label: 'la page' }), null);
  assert.equal(normaliseReplyLink({ url: 'https://example.com', label: 'x'.repeat(MAX_LINK_LABEL + 1) }), null);
  assert.equal(normaliseReplyLink(null), null);
});

test('markers are found in order, and prose is not a marker', () => {
  const markers = findLinkMarkers('Cliquez [[ici]] ou [[here]]. [[pas\nun marqueur]] [texte](lien)');
  assert.deepEqual(markers.map((m) => m.anchor), ['ici', 'here']);
});

test('the marked word becomes the link and the rest stays text', () => {
  assert.deepEqual(splitLinkMarkers('Cliquez [[ici]] pour consulter le guide.', LINK), [
    { text: 'Cliquez ' },
    { text: 'ici', url: LINK.url },
    { text: ' pour consulter le guide.' }
  ]);
});

test('with no usable link the text, marker and all, comes back whole', () => {
  // Rendered as written so a reviewer sees the orphan marker the check failed.
  assert.deepEqual(splitLinkMarkers('Cliquez [[ici]].', null), [{ text: 'Cliquez [[ici]].' }]);
  assert.deepEqual(splitLinkMarkers('Cliquez [[ici]].', { url: 'http://x.com', label: 'x' }), [
    { text: 'Cliquez [[ici]].' }
  ]);
});

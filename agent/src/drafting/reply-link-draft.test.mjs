import assert from 'node:assert/strict';
import test from 'node:test';

import { caseFileFromRow, composeDraftingMessage, promptInputs } from './compose-draft.mjs';
import { runDraftChecks } from './draft-checks.mjs';

// A rule's link, from the stored row to the prompt and the checks.

const URL = 'https://example.com/guide-masque-led';
const ROW = {
  verdict: 'answerable',
  exemplar_match: {
    policy: { link: { url: URL, label: 'le guide d’utilisation du masque' }, answer_skeleton: 'Donner le guide.' }
  }
};
const MESSAGE = { subject: 'Masque LED', body_text: 'Comment utiliser le masque ?' };

const checkNamed = (checks, name) => checks.find((check) => check.check === name);

test('the link is read by name from the policy, and a malformed one is dropped', () => {
  assert.deepEqual(caseFileFromRow(ROW).link, { url: URL, label: 'le guide d’utilisation du masque' });
  assert.equal(caseFileFromRow({ exemplar_match: { policy: { link: { url: 'http://x.com', label: 'x' } } } }).link, null);
  assert.equal(caseFileFromRow({}).link, null);
});

test('the prompt gets the description and the marker, never the address', () => {
  const prompt = composeDraftingMessage({ message: MESSAGE, caseFile: caseFileFromRow(ROW) });
  assert.match(prompt, /## Lien à proposer au client/);
  assert.match(prompt, /le guide d’utilisation du masque/);
  assert.match(prompt, /\[\[ici\]\]/);
  assert.ok(!prompt.includes(URL), 'the URL must never reach the model');
  assert.ok(!prompt.includes('example.com'));
});

test('no link leaves the prompt exactly as it was', () => {
  const caseFile = caseFileFromRow({ verdict: 'answerable' });
  const prompt = composeDraftingMessage({ message: MESSAGE, caseFile });
  assert.ok(!prompt.includes('Lien à proposer'));
  assert.equal(prompt, composeDraftingMessage({ message: MESSAGE, caseFile: { ...caseFile, link: undefined } }));
});

test('with a link, exactly one marker passes', () => {
  const link = caseFileFromRow(ROW).link;
  const one = runDraftChecks({ body: 'Cliquez [[ici]] pour consulter le guide.', replyLink: link });
  assert.equal(checkNamed(one, 'link_placed').passed, true);

  const none = runDraftChecks({ body: 'Voici comment utiliser le masque.', replyLink: link });
  assert.equal(checkNamed(none, 'link_placed').passed, false);

  const two = runDraftChecks({ body: 'Cliquez [[ici]] ou [[là]].', replyLink: link });
  assert.equal(checkNamed(two, 'link_placed').passed, false);
});

test('a marker with no link to put on it fails', () => {
  const checks = runDraftChecks({ body: 'Cliquez [[ici]].' });
  assert.equal(checkNamed(checks, 'no_orphan_link_marker').passed, false);
  assert.equal(checkNamed(checks, 'link_placed'), undefined);
});

test('no link and no marker adds neither check', () => {
  const checks = runDraftChecks({ body: 'Bonjour, votre commande est partie.' });
  assert.equal(checkNamed(checks, 'link_placed'), undefined);
  assert.equal(checkNamed(checks, 'no_orphan_link_marker'), undefined);
});

test('a pasted address still fails no_web_link, link or not', () => {
  const checks = runDraftChecks({
    body: `Cliquez [[ici]] : ${URL}`,
    replyLink: caseFileFromRow(ROW).link
  });
  assert.equal(checkNamed(checks, 'no_web_link').passed, false);
});

test('the prompt inputs say whether a link was offered, without the address', () => {
  const offered = promptInputs({ caseFile: caseFileFromRow(ROW), investigationId: 'i', model: 'm' });
  assert.equal(offered.reply_link, true);
  assert.ok(!JSON.stringify(offered).includes(URL));
  assert.equal(promptInputs({ caseFile: caseFileFromRow({}), investigationId: 'i', model: 'm' }).reply_link, false);
});

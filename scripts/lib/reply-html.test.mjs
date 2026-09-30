import assert from 'node:assert/strict';
import test from 'node:test';

import { isSafeReplyHref, replyHtmlIsEmpty, replyHtmlToText, sanitiseReplyHtml, textToReplyHtml } from './reply-html.mjs';

const LINK = { url: 'https://qiriness.com/guide', label: 'le guide' };

test('the allowed subset survives, rewritten from the list', () => {
  assert.equal(
    sanitiseReplyHtml('<p>Bonjour <b>Anne</b>, <i>merci</i> <u>!</u></p>'),
    '<p>Bonjour <strong>Anne</strong>, <em>merci</em> <u>!</u></p>'
  );
  assert.equal(sanitiseReplyHtml('<ul><li>un</li><li>deux</li></ul>'), '<ul><li>un</li><li>deux</li></ul>');
});

test('attributes never pass, and a link keeps only a checked href', () => {
  assert.equal(
    sanitiseReplyHtml('<p style="color:red" onclick="x()">a <a href="https://x.fr/p" target="_blank" onmouseover="y()">lien</a></p>'),
    '<p>a <a href="https://x.fr/p">lien</a></p>'
  );
  assert.equal(sanitiseReplyHtml('<a href="javascript:alert(1)">clic</a>'), 'clic');
  assert.equal(sanitiseReplyHtml('<a href="http://x.fr">clic</a>'), 'clic');
  assert.equal(sanitiseReplyHtml('<a href="mailto:a@b.fr">écrire</a>'), '<a href="mailto:a@b.fr">écrire</a>');
});

test('scripts and styles go with their content; unknown tags are unwrapped', () => {
  assert.equal(sanitiseReplyHtml('<p>a<script>alert(1)</script>b</p><style>p{}</style>'), '<p>ab</p>');
  assert.equal(sanitiseReplyHtml('<span class="x">mot</span> <font>deux</font>'), 'mot deux');
  assert.equal(sanitiseReplyHtml('<img src=x onerror=alert(1)>'), '');
});

test('stray angle brackets and entities come out as text', () => {
  assert.equal(sanitiseReplyHtml('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
  assert.equal(sanitiseReplyHtml('&lt;script&gt;'), '&lt;script&gt;');
});

test('contentEditable divs become paragraphs and open tags are closed', () => {
  assert.equal(sanitiseReplyHtml('<div>un</div><div><br></div><div>deux'), '<p>un</p><p><br></p><p>deux</p>');
  assert.equal(sanitiseReplyHtml('<b>gras <i>et</b> fin'), '<strong>gras <em>et</em></strong> fin');
});

test('plain text becomes paragraphs, and the marker becomes its link', () => {
  assert.equal(
    textToReplyHtml('Bonjour,\n\nCliquez [[ici]] pour <voir>.\nMerci'),
    '<p>Bonjour,</p>\n<p>Cliquez [[ici]] pour &lt;voir&gt;.<br>Merci</p>'
  );
  assert.equal(
    textToReplyHtml('Cliquez [[ici]].', LINK),
    '<p>Cliquez <a href="https://qiriness.com/guide">ici</a>.</p>'
  );
});

test('HTML back to text keeps the draft marker, so an untouched draft reads unchanged', () => {
  const text = 'Bonjour,\n\nCliquez [[ici]] pour le guide.';
  assert.equal(replyHtmlToText(textToReplyHtml(text, LINK), { link: LINK }), text);
});

test('other links read as words and address; lists are dashed', () => {
  assert.equal(
    replyHtmlToText('<p>Voir <a href="https://x.fr/a">la page</a>.</p><ul><li>un</li><li><b>deux</b></li></ul>'),
    'Voir la page (https://x.fr/a).\n\n- un\n- deux'
  );
  assert.equal(replyHtmlToText('<p><a href="https://x.fr/a">https://x.fr/a</a> &amp; co</p>'), 'https://x.fr/a & co');
});

test('an editor holding only empty lines is empty', () => {
  assert.equal(replyHtmlIsEmpty('<div><br></div><p>&nbsp;</p>'), true);
  assert.equal(replyHtmlIsEmpty('<p>ok</p>'), false);
});

test('safe hrefs', () => {
  assert.equal(isSafeReplyHref('https://qiriness.com'), true);
  assert.equal(isSafeReplyHref('ftp://x.fr'), false);
  assert.equal(isSafeReplyHref('mailto:x'), false);
});

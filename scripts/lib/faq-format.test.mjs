import test from 'node:test';
import assert from 'node:assert/strict';

import { htmlToSections } from './html-to-text.mjs';
import { buildFormatPrompt, renderFaq, splitIntoBlocks } from './faq-format.mjs';

const ARTICLE =
  '<h3>Livraison</h3>' +
  '<p><strong>Où en est ma commande ?</strong><br>Je n\'ai pas de nouvelles<br>Comment suivre mon colis ?</p>' +
  '<p>Dès l\'expédition, vous recevez un <a href="https://x.test">lien de suivi</a>.</p>' +
  '<div>Le colis arrive en 48 h.</div>' +
  '<ul><li>Colissimo</li><li>Relais <ul><li>Mondial</li></ul></li></ul>' +
  '<p>&nbsp;</p>';

test('splitIntoBlocks: headings, one block per line, lists kept whole, empties dropped', () => {
  const blocks = splitIntoBlocks(ARTICLE);
  assert.deepEqual(
    blocks.map((block) => [block.kind, block.text]),
    [
      ['heading', 'Livraison'],
      ['line', 'Où en est ma commande ?'],
      ['line', 'Je n\'ai pas de nouvelles'],
      ['line', 'Comment suivre mon colis ?'],
      ['line', 'Dès l\'expédition, vous recevez un lien de suivi .'],
      ['line', 'Le colis arrive en 48 h.'],
      ['list', 'Colissimo\n\nRelais\n\nMondial']
    ]
  );
  assert.equal(blocks[4].html, 'Dès l\'expédition, vous recevez un <a href="https://x.test">lien de suivi</a>.');
  assert.ok(blocks[6].html.startsWith('<ul>') && blocks[6].html.endsWith('</ul></li></ul>'));
});

test('buildFormatPrompt numbers every block and marks its kind', () => {
  const { user } = buildFormatPrompt(splitIntoBlocks(ARTICLE), { title: 'FAQ livraison' });
  assert.match(user, /^Article title: FAQ livraison/);
  assert.match(user, /\[0\] HEADING Livraison/);
  assert.match(user, /\[6\] LIST Colissimo \/ Relais \/ Mondial/);
});

test('renderFaq rebuilds the FAQ shape from the original blocks, word for word', () => {
  const blocks = splitIntoBlocks(ARTICLE);
  const result = renderFaq(blocks, {
    sections: [
      { question_block: 1, question: 'ignored', rewording_blocks: [2, 3], answer_blocks: [5, 4, 6] }
    ]
  });
  assert.equal(
    result.html,
    '<h2>Où en est ma commande ?</h2>' +
      '<p>Je n\'ai pas de nouvelles</p><p>Comment suivre mon colis ?</p>' +
      '<p>Dès l\'expédition, vous recevez un <a href="https://x.test">lien de suivi</a>.</p>' +
      '<p>Le colis arrive en 48 h.</p>' +
      blocks[6].html
  );
  assert.deepEqual(
    { questions: result.questions, withoutRewordings: result.withoutRewordings, unplaced: result.unplaced },
    { questions: 1, withoutRewordings: 0, unplaced: 0 }
  );

  // What retrieval will see: one section, its rewordings travelling with the answer.
  const sections = htmlToSections(result.html, 'FAQ livraison');
  assert.equal(sections.length, 1);
  assert.equal(sections[0].heading, 'Où en est ma commande ?');
  assert.match(sections[0].text, /^Je n'ai pas de nouvelles\n+Comment suivre mon colis \?\n+Dès/);
});

test('renderFaq: a written question only when no block holds one', () => {
  const blocks = splitIntoBlocks('<h2>Livraison</h2><p>Sous 48 h.</p>');
  const result = renderFaq(blocks, {
    sections: [{ question_block: -1, question: '  Quel est le délai\nde livraison ? ', rewording_blocks: [], answer_blocks: [1] }]
  });
  assert.equal(result.html, '<h2>Quel est le délai de livraison ?</h2><p>Sous 48 h.</p>');
  assert.equal(result.withoutRewordings, 1);
});

test('renderFaq never duplicates or loses content, whatever the plan says', () => {
  const blocks = splitIntoBlocks('<h2>Groupe</h2><p>A</p><p>B</p><p>C</p><p>D</p>');
  const result = renderFaq(blocks, {
    sections: [
      { question_block: 1, question: '', rewording_blocks: [99, -3], answer_blocks: [2, 2, 1.5] },
      { question_block: 2, question: '', rewording_blocks: [], answer_blocks: [3] },
      { question_block: -1, question: '   ', rewording_blocks: [], answer_blocks: [4] }
    ]
  });
  // C and D were only in entries left with no question (one reused A's block),
  // so they are unplaced and kept first;
  // the unused grouping heading is dropped.
  assert.equal(result.html, '<p>C</p><p>D</p><h2>A</h2><p>B</p>');
  assert.equal(result.unplaced, 2);
  assert.equal(result.questions, 1);
});

test('renderFaq with an empty plan keeps every content block', () => {
  const blocks = splitIntoBlocks('<p>A</p><ol><li>x</li></ol>');
  assert.equal(renderFaq(blocks, { sections: [] }).html, '<p>A</p><ol><li>x</li></ol>');
});

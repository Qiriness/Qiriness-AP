/**
 * « Format as FAQ »: rearranges an article into the FAQ shape retrieval reads
 * (DECISIONS.md § Knowledge articles are FAQs) — one Heading 2 per question, its
 * rewordings as plain lines underneath, then the answer.
 *
 * A FORMATTER, NOT A WRITER. The model is shown the article as numbered blocks
 * and answers with block NUMBERS: which block is a question, which are
 * rewordings of it, which answer it. The HTML is then rebuilt here from the
 * original blocks, so an answer comes out word for word as it went in. The one
 * thing the model may write is a question heading, and only for a topic that
 * has none (« Livraison » as a label, or no heading at all) — a section without
 * a heading is not an FAQ entry. It never writes rewordings: the guide says to
 * take them from real emails, and a model's guesses would look like real ones.
 *
 * NOTHING IS LOST. A content block the model did not place is kept, ahead of the
 * first question, and counted so the editor can say so. Only headings it did not
 * use are dropped: a grouping label with no text of its own is a section that
 * `htmlToSections` already skips, so dropping it changes no chunk.
 *
 * Pure: no I/O. The call itself lives in web/lib/server/knowledge-service.ts.
 */

import { htmlToText } from './html-to-text.mjs';

/** Kept as one block: a list item or a table cell out of context is not an answer. */
const ATOMIC_TAGS = new Set(['ul', 'ol', 'table', 'dl']);
const HEADING_TAG = /^h[1-6]$/;
/** Tags that end the current line. Everything else (b, i, a, span…) stays inside it. */
const BREAK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'div', 'figcaption', 'figure', 'footer',
  'header', 'hr', 'li', 'main', 'nav', 'p', 'pre', 'section'
]);

/**
 * The article as an ordered list of blocks: one per heading, per line of text
 * (a <br> is a line: rewordings are usually typed one per line in a paragraph),
 * and one per list or table.
 *
 * @param {string} html
 * @returns {{kind: 'heading' | 'line' | 'list', html: string, text: string}[]}
 */
export function splitIntoBlocks(html) {
  const source = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  const blocks = [];
  const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  let buffer = '';
  let inHeading = false;
  let cursor = 0;

  function flush(kind) {
    const text = htmlToText(buffer);
    if (text) blocks.push({ kind, html: buffer.trim(), text });
    buffer = '';
  }

  for (let match = tagPattern.exec(source); match; match = tagPattern.exec(source)) {
    buffer += source.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    const closing = match[1] === '/';
    const tag = match[2].toLowerCase();

    if (!closing && ATOMIC_TAGS.has(tag)) {
      flush(inHeading ? 'heading' : 'line');
      const end = matchingClose(source, tag, cursor);
      blocks.push(...nonEmpty('list', source.slice(match.index, end)));
      cursor = end;
      tagPattern.lastIndex = end;
    } else if (HEADING_TAG.test(tag)) {
      flush(inHeading ? 'heading' : 'line');
      inHeading = !closing;
    } else if (BREAK_TAGS.has(tag)) {
      flush(inHeading ? 'heading' : 'line');
    } else {
      buffer += match[0];
    }
  }
  buffer += source.slice(cursor);
  flush(inHeading ? 'heading' : 'line');
  return blocks;
}

function nonEmpty(kind, html) {
  const text = htmlToText(html);
  return text ? [{ kind, html: html.trim(), text }] : [];
}

/** Where `tag`, opened just before `from`, closes — counting nested ones. */
function matchingClose(source, tag, from) {
  const pattern = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  pattern.lastIndex = from;
  let depth = 1;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    depth += match[1] === '/' ? -1 : 1;
    if (depth === 0) return match.index + match[0].length;
  }
  return source.length;
}

export const FAQ_FORMAT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['sections'],
  properties: {
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question_block', 'question', 'rewording_blocks', 'answer_blocks'],
        properties: {
          question_block: { type: 'integer' },
          question: { type: 'string' },
          rewording_blocks: { type: 'array', items: { type: 'integer' } },
          answer_blocks: { type: 'array', items: { type: 'integer' } }
        }
      }
    }
  }
});

const SYSTEM_PROMPT = `You arrange a customer-service FAQ article. You do not write it.

The article is given as numbered blocks. Group them into FAQ entries, one customer question per entry, and answer with block numbers. The article is rebuilt from your numbers, so the answers keep their exact wording.

For each entry:
- question_block: the block that already states the question (a heading, or a line phrased as a question). Copy its text into "question".
- If no block states the question (the topic only has a label heading such as "Delivery", or no heading at all), set question_block to -1 and write in "question" the question a customer would ask, in the article's language, using only what its answer says. At most 15 words.
- rewording_blocks: lines that are other ways of asking the same question. Never write rewordings yourself; leave the list empty when there are none.
- answer_blocks: every block that answers the question, in order.

Rules:
- Use each block number at most once.
- Place every block that carries content. Leave out only headings that are labels for a group of questions.
- Never split a block. Split a long topic into several entries only where its blocks already answer different questions.
- Keep the entries in the order the article gives them.`;

/**
 * @param {{kind: string, text: string}[]} blocks
 * @param {{title?: string}} [options]
 */
export function buildFormatPrompt(blocks, { title = '' } = {}) {
  const lines = blocks.map((block, index) => {
    const label = block.kind === 'heading' ? 'HEADING ' : block.kind === 'list' ? 'LIST ' : '';
    return `[${index}] ${label}${block.text.replace(/\s*\n\s*/g, ' / ')}`;
  });
  return {
    system: SYSTEM_PROMPT,
    user: `Article title: ${title || '(untitled)'}\n\nBlocks:\n${lines.join('\n')}`
  };
}

/**
 * The article rebuilt from the model's plan. Every index is checked here, not
 * trusted: out of range or already used is ignored, so a bad plan can misplace
 * a block but never duplicate or lose one.
 *
 * @param {{kind: string, html: string, text: string}[]} blocks
 * @param {{sections?: {question_block: number, question: string, rewording_blocks: number[], answer_blocks: number[]}[]}} plan
 * @returns {{html: string, questions: number, withoutRewordings: number, unplaced: number}}
 */
export function renderFaq(blocks, plan) {
  const used = new Set();
  const take = (index) => {
    if (!Number.isInteger(index) || index < 0 || index >= blocks.length || used.has(index)) return false;
    used.add(index);
    return true;
  };

  const entries = [];
  for (const section of plan?.sections ?? []) {
    const fromBlock = take(section.question_block) ? blocks[section.question_block].text : '';
    const question = oneLine(fromBlock || section.question);
    if (!question) continue;
    const rewordings = (section.rewording_blocks ?? []).filter(take).map((index) => blocks[index]);
    const answers = (section.answer_blocks ?? []).filter(take).sort((a, b) => a - b).map((index) => blocks[index]);
    entries.push({ question, rewordings, answers });
  }

  const unplaced = blocks.filter((block, index) => !used.has(index) && block.kind !== 'heading');
  const html = [
    ...unplaced.map(blockHtml),
    ...entries.flatMap(({ question, rewordings, answers }) => [
      `<h2>${escapeHtml(question)}</h2>`,
      ...rewordings.map((block) => `<p>${escapeHtml(oneLine(block.text))}</p>`),
      ...answers.map(blockHtml)
    ])
  ].join('');

  return {
    html,
    questions: entries.length,
    withoutRewordings: entries.filter((entry) => entry.rewordings.length === 0).length,
    unplaced: unplaced.length
  };
}

function blockHtml(block) {
  if (block.kind === 'list') return block.html;
  if (block.kind === 'heading') return `<p><strong>${escapeHtml(oneLine(block.text))}</strong></p>`;
  return `<p>${block.html}</p>`;
}

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

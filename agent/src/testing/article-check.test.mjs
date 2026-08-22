import assert from 'node:assert/strict';
import test from 'node:test';

import { TOOL_NAMES } from '../investigation/investigation-rules.mjs';
import { ANSWERABLE, WEAK } from '../retrieval/retrieval-rules.mjs';

import { ARTICLE_VERDICTS, articleReadiness, checkArticle } from './article-check.mjs';

const DOC = 'doc-1';
const OTHER = 'doc-2';

const search = (candidates) => ({
  tool: TOOL_NAMES.SEARCH_KNOWLEDGE,
  detail: { candidates }
});

const chunk = (documentId, similarity, chunkId = `${documentId}-${similarity}`) => ({
  chunkId,
  documentId,
  title: documentId,
  similarity
});

const allTools = [TOOL_NAMES.SEARCH_KNOWLEDGE, TOOL_NAMES.LOOKUP_PRODUCT];

// --- the five verdicts --------------------------------------------------------

test('used: a chunk of it reached the drafting model', () => {
  const result = checkArticle({
    documentId: DOC,
    toolCalls: [search([chunk(DOC, 0.71)])],
    knowledge: [{ documentId: DOC, title: 'Retours' }],
    allowedTools: allTools
  });
  assert.equal(result.verdict, 'used');
  assert.equal(result.rank, 1);
  assert.equal(result.best.band, 'answerable');
});

test('retrieved_withheld: found, but the band refused it', () => {
  // The distinction the whole feature turns on. Without the candidate list this
  // is indistinguishable from "never found", and the two want opposite fixes.
  const result = checkArticle({
    documentId: DOC,
    toolCalls: [search([chunk(DOC, 0.52)])],
    knowledge: [],
    allowedTools: allTools
  });
  assert.equal(result.verdict, 'retrieved_withheld');
  assert.equal(result.best.similarity, 0.52);
  assert.equal(result.best.band, 'weak');
  assert.deepEqual(result.bands, { answerable: ANSWERABLE, weak: WEAK });
});

test('a score under the weak floor is still retrieved_withheld, not missing', () => {
  const result = checkArticle({
    documentId: DOC,
    toolCalls: [search([chunk(DOC, 0.2)])],
    knowledge: [],
    allowedTools: allTools
  });
  assert.equal(result.verdict, 'retrieved_withheld');
  assert.equal(result.best.band, 'none');
});

test('outranked: it cleared the bar and other chunks took the places', () => {
  const result = checkArticle({
    documentId: DOC,
    toolCalls: [search([chunk(OTHER, 0.8), chunk(OTHER, 0.75, 'x'), chunk(DOC, 0.65)])],
    knowledge: [{ documentId: OTHER }],
    allowedTools: allTools
  });
  assert.equal(result.verdict, 'outranked');
  assert.equal(result.rank, 3);
  assert.equal(result.poolSize, 3);
});

test('not_retrieved: the search ran and this article was not in the pool', () => {
  const result = checkArticle({
    documentId: DOC,
    toolCalls: [search([chunk(OTHER, 0.8)])],
    knowledge: [],
    allowedTools: allTools
  });
  assert.equal(result.verdict, 'not_retrieved');
  assert.equal(result.best, null);
  assert.equal(result.rank, null);
  assert.equal(result.searched, true);
});

test('not_searched: the knowledge tool never ran', () => {
  // The one people will hit and not expect. `allowedTools` gives searchKnowledge
  // to five subjects; a message that lands on `delivery` has no knowledge tool
  // at all, so the best article in the library cannot be reached from it.
  const result = checkArticle({
    documentId: DOC,
    toolCalls: [{ tool: TOOL_NAMES.GET_ORDER_CONTEXT, detail: {} }],
    knowledge: [],
    allowedTools: [TOOL_NAMES.GET_ORDER_CONTEXT]
  });
  assert.equal(result.verdict, 'not_searched');
  assert.equal(result.searched, false);
  // And the half that says whether the model COULD have looked.
  assert.equal(result.offered, false);
});

test('not_searched separates "chose not to look" from "could not have"', () => {
  const result = checkArticle({
    documentId: DOC,
    toolCalls: [],
    knowledge: [],
    allowedTools: allTools
  });
  assert.equal(result.verdict, 'not_searched');
  assert.equal(result.offered, true, 'the tool was available and went unused');
});

test('every verdict it can return is one the schema accepts', () => {
  // The constraint in 08_testing.sql cannot import this module; the migration
  // test asserts the other direction, and this asserts the list is exhaustive.
  const produced = new Set();
  for (const scenario of [
    { toolCalls: [search([chunk(DOC, 0.7)])], knowledge: [{ documentId: DOC }] },
    { toolCalls: [search([chunk(DOC, 0.52)])], knowledge: [] },
    { toolCalls: [search([chunk(OTHER, 0.9), chunk(DOC, 0.65)])], knowledge: [{ documentId: OTHER }] },
    { toolCalls: [search([chunk(OTHER, 0.9)])], knowledge: [] },
    { toolCalls: [], knowledge: [] }
  ]) {
    produced.add(checkArticle({ documentId: DOC, allowedTools: allTools, ...scenario }).verdict);
  }
  assert.deepEqual([...produced].sort(), [...ARTICLE_VERDICTS].sort());
});

// --- the pool -----------------------------------------------------------------

test('one chunk found by two searches is one candidate at its better score', () => {
  // A decomposed email searches knowledge twice. Two rows for one chunk would
  // imply two hits and push everything below it down a rank.
  const result = checkArticle({
    documentId: DOC,
    toolCalls: [search([chunk(DOC, 0.4, 'same')]), search([chunk(DOC, 0.66, 'same')])],
    knowledge: [],
    allowedTools: allTools
  });
  assert.equal(result.poolSize, 1);
  assert.equal(result.best.similarity, 0.66);
  assert.equal(result.verdict, 'outranked', 'it cleared the bar; nothing reached the model');
});

test('no article asked about means no verdict at all', () => {
  assert.equal(checkArticle({ documentId: null }), null);
});

// --- readiness, checked before a run is paid for ------------------------------

test('an unapproved article is unreachable, and that is said before any spend', () => {
  // A chunk holds a vector only if its parent is approved (03_knowledge.sql), so
  // retrieval cannot reach it no matter what the operator types.
  const result = articleReadiness({
    document: { approval_status: 'in_review' },
    chunks: [{ embedded: true }]
  });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'not_approved');
});

test('the brand voice article is not retrievable knowledge and never was', () => {
  const result = articleReadiness({
    document: { approval_status: 'approved', core_topic: 'brand' },
    chunks: []
  });
  assert.equal(result.reason, 'brand_voice');
});

test('chunks without vectors are the common failure and are named as such', () => {
  const result = articleReadiness({
    document: { approval_status: 'approved' },
    chunks: [{ embedded: false }, { embedded: false }]
  });
  assert.equal(result.reason, 'not_embedded');
  assert.match(result.message, /embed:knowledge/);
});

test('an approved, embedded article reports the categories retrieval will search', () => {
  const result = articleReadiness({
    document: { approval_status: 'approved' },
    chunks: [
      { embedded: true, category: 'faq' },
      { embedded: true, category: 'faq' },
      { embedded: false, category: 'faq' }
    ]
  });
  assert.equal(result.ready, true);
  assert.equal(result.chunks, 3);
  assert.equal(result.embedded, 2);
  assert.deepEqual(result.categories, ['faq']);
});

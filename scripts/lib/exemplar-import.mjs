import { NEED_KEYS } from '../../agent/src/investigation/evidence-rules.mjs';
import { REQUEST_KINDS, TICKET_SUBJECTS } from './support-taxonomy.mjs';

// Reads Email-Example-Queries.md into exemplar rows.
//
// Pure: markdown in, plain objects out. No database, no clock, no network — so
// every judgement below is unit-testable and the script stays a thin shell.
//
// THE SOURCE IS PROSE WRITTEN FOR PEOPLE, and it is not going to become a data
// format. It carries two categories on one entry, message counts that are
// sometimes a note instead of a number, emoji status markers, and one "variant"
// that is actually a quote from our own reply. So this parser is deliberately
// forgiving about shape and strict about vocabulary: anything it cannot read it
// reports rather than guesses at, and every value it does read is clamped to a
// list the rest of the system already owns.
//
// EVERYTHING IMPORTS AS A DRAFT. Approval gates the vector, so nothing this
// produces is reachable by retrieval until a person has read it. That is the
// safety property that lets the parser be forgiving: a misparse costs a review,
// not a wrong answer to a customer. It is also where the personal data in real
// phrasings gets looked at — several quote order numbers.

/**
 * Where translated phrasings start, and why authored ones must stay below it.
 *
 * `import-exemplars.mjs` prunes by POSITION: a phrasing at or past the end of
 * the authored list is text nobody wrote any more, so it is deleted. That rule
 * is correct for authored phrasings and lethal for translations, which are
 * generated separately and would otherwise be wiped on the next import. So the
 * two live in separate index ranges, and `05_exemplars.sql` enforces the split
 * with a check constraint rather than leaving two scripts to agree by habit.
 *
 * 100 is far above anything the document produces — the largest entry has five
 * phrasings — so there is no arithmetic to get wrong at the boundary.
 */
export const TRANSLATION_INDEX_BASE = 100;

/** `### D-01 · Où en est ma commande ?` */
const HEADING = /^###\s+([A-Z]{1,3}-\d{2})\s+·\s+(.+?)\s*$/;

/** The metadata line under a heading: `` `delivery` · `problem` · **19 msgs** `` */
const BACKTICKED = /`([^`]+)`/g;
const MESSAGE_COUNT = /\*\*(\d+)\s*msgs?\*\*/i;

/** `- « ... »`, with an optional trailing _(annotation)_. */
const VARIANT = /^[-*]\s+«\s*([\s\S]+?)\s*»\s*(?:_\(([^)]*)\)_)?\s*$/;

const NEEDS_LINE = /^\*\*needs\*\*\s*(.+)$/i;
const VARIANTS_HEADING = /^\*\*Variantes\s+réelles\*\*/i;

/**
 * Splits the document into one block per exemplar.
 *
 * Keyed on the heading rather than on the `#` section titles, because the
 * sections are subject groupings ("Livraison — 8 questions") whose names are not
 * the taxonomy and are not needed: every entry states its own category.
 */
export function parseExemplarDocument(markdown, { warn = () => {} } = {}) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const blocks = [];
  let current = null;

  for (const line of lines) {
    const heading = HEADING.exec(line);
    if (heading) {
      if (current) blocks.push(current);
      current = { key: heading[1], question: heading[2], lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) blocks.push(current);

  const exemplars = [];
  const seen = new Set();

  for (const block of blocks) {
    if (seen.has(block.key)) {
      warn(`duplicate exemplar key ${block.key}; keeping the first`);
      continue;
    }
    seen.add(block.key);
    exemplars.push(parseBlock(block, warn));
  }

  return exemplars;
}

function parseBlock(block, warn) {
  const { category, secondaryCategory, requestKind, marker } = parseMeta(block, warn);

  return {
    exemplarKey: block.key,
    canonicalQuestion: collapse(block.question),
    category,
    requestKind,
    requirementNeeds: parseNeeds(block, warn),
    demandMessageCount: parseCount(block),
    phrasings: parsePhrasings(block, warn),
    // Everything the taxonomy could not hold, kept as prose rather than dropped:
    // the reachability marker, and the second subject on the entries that name
    // two. A reviewer needs both and neither has a column.
    sourceNote: buildNote({ marker, secondaryCategory })
  };
}

/**
 * The metadata line: category, kind, and the status marker.
 *
 * TWO ENTRIES NAME TWO CATEGORIES (`order` / `promotions`). The first wins and
 * the second is kept in the note, because `category` drives the retrieval filter
 * and a ticket only ever has one subject to match it against. Guessing which of
 * the two is "really" primary is exactly the judgement a reviewer should make.
 */
function parseMeta(block, warn) {
  const line = block.lines.find((l) => l.trim().startsWith('`')) ?? '';
  const tokens = [...line.matchAll(BACKTICKED)].map((m) => m[1].trim());

  const categories = tokens.filter((t) => TICKET_SUBJECTS.includes(t));
  const kinds = tokens.filter((t) => REQUEST_KINDS.includes(t));

  if (categories.length === 0) {
    warn(`${block.key}: no recognised category on « ${line.trim()} »`);
  }
  if (kinds.length === 0) {
    warn(`${block.key}: no recognised request_kind on « ${line.trim()} »`);
  }

  return {
    category: categories[0] ?? null,
    secondaryCategory: categories[1] ?? null,
    requestKind: kinds[0] ?? null,
    // The emoji is load-bearing in the source: 🔒 means the tool needed to
    // answer this does not exist yet.
    marker: line.includes('🔒') ? 'blocked' : line.includes('🟢') ? 'reachable' : null
  };
}

/**
 * `**needs** `order_identity`, `delivery_state``
 *
 * Clamped to the investigation vocabulary. A need this codebase cannot score is
 * a requirement nothing could ever satisfy, so an unrecognised one is dropped
 * loudly rather than written and left to fail a check constraint at insert.
 */
function parseNeeds(block, warn) {
  const line = block.lines.find((l) => NEEDS_LINE.test(l.trim()));
  if (!line) {
    return [];
  }
  const declared = [...NEEDS_LINE.exec(line.trim())[1].matchAll(BACKTICKED)].map((m) => m[1].trim());
  const kept = [];
  for (const need of declared) {
    if (NEED_KEYS.includes(need)) {
      if (!kept.includes(need)) kept.push(need);
    } else {
      warn(`${block.key}: unknown need « ${need} » dropped`);
    }
  }
  return kept;
}

function parseCount(block) {
  for (const line of block.lines) {
    const match = MESSAGE_COUNT.exec(line);
    // Only the metadata line carries it; a count inside prose further down would
    // be about something else.
    if (match && line.trim().startsWith('`')) {
      return Number(match[1]);
    }
  }
  return null;
}

/**
 * The canonical question plus every real phrasing, as retrieval rows.
 *
 * Index 0 is always the canonical question, so a phrasing's position is stable
 * across re-imports and the upsert can key on it. Only the bullets under
 * **Variantes réelles** are read: a quoted line elsewhere in the block is prose
 * about the situation, not a way of saying it.
 */
function parsePhrasings(block, warn) {
  const phrasings = [
    { index: 0, kind: 'canonical', text: collapse(block.question) }
  ];

  let inVariants = false;
  const seen = new Set([collapse(block.question).toLowerCase()]);

  for (const raw of block.lines) {
    const line = raw.trim();
    if (VARIANTS_HEADING.test(line)) {
      inVariants = true;
      continue;
    }
    // Any other bold heading closes the list — **needs**, **exemplaires**,
    // **Contenu stable**.
    if (inVariants && line.startsWith('**')) {
      inVariants = false;
      continue;
    }
    if (!inVariants) continue;

    const match = VARIANT.exec(line);
    if (!match) continue;

    const text = collapse(match[1]);
    const annotation = match[2] ?? '';

    // ONE ENTRY QUOTES OUR OWN REPLY rather than a customer. Embedding it would
    // put an answer into the corpus of questions, which is the one thing the
    // separate-tables decision exists to prevent — so it is skipped here too,
    // and named so the omission is visible.
    if (/our own reply/i.test(annotation)) {
      warn(`${block.key}: skipped a phrasing annotated as our own reply`);
      continue;
    }

    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    phrasings.push({ index: phrasings.length, kind: 'variant', text });
  }

  return phrasings;
}

function buildNote({ marker, secondaryCategory }) {
  const parts = [];
  if (marker === 'blocked') {
    parts.push('Source marks this as blocked: the tool needed to answer it does not exist yet.');
  }
  if (secondaryCategory) {
    parts.push(`Source names a second subject: ${secondaryCategory}.`);
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * Collapses whitespace. Must match `buildExemplarEmbeddingInput`, or a phrasing
 * would hash differently from the text that was embedded and re-embed forever.
 */
function collapse(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * What a row needs before it can be written.
 *
 * Reported rather than thrown: one unreadable entry in a document of 32 should
 * not stop the other 31 from importing, and a list of what was skipped is more
 * useful than a stack trace at the first problem.
 */
export function validateExemplar(exemplar) {
  const problems = [];
  if (!exemplar.canonicalQuestion) problems.push('no canonical question');
  if (!exemplar.category) problems.push('no recognised category');
  if (exemplar.phrasings.length === 0) problems.push('no phrasings');
  return problems;
}

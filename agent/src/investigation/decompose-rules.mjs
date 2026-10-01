import { REQUEST_KINDS, TICKET_SUBJECTS } from '../../../scripts/lib/support-taxonomy.mjs';

import { DESCRIBED_MECHANIC_KEYS } from '../retrieval/promotion-lookup.mjs';

import { ENABLED_SUBJECTS, TOOL_NAMES, allowedTools, openingMoves, requiredEvidence } from './investigation-rules.mjs';

// Turning one email into the separate tasks it actually contains — the pure half.
//
// WHY DECOMPOSITION RATHER THAN QUERY REWRITING. The usual retrieval upgrade is
// to paraphrase a question into variants and union the results, which fixes a
// VOCABULARY problem. This corpus has a ROUTING problem instead: an email asking
// whether the LED mask suits sensitive skin *and* where order #4854 is contains
// two requests whose answers live in completely different places — one in the
// product row, one in the order tools. One blended embedding matches neither
// well, and no amount of rewriting fixes that.
//
// The database already says this happens: `tickets.secondary_category` and
// `secondary_request_kind` exist because real mail raises two subjects of
// different kinds, and the categoriser already detects it. Nothing downstream
// has ever used it.
//
// BOUNDED, NOT OPEN-ENDED PLANNING. The model proposes tasks; it never invents
// its own vocabulary or its own tools. Every task is clamped to the existing
// (subject, kind) taxonomy here, so it routes through the same
// `allowedTools`/`openingMoves` table as any other ticket — a table tested
// across all 14 subjects × 4 kinds whose outside the model never sees. That is
// the project's rule that guardrails are code and only guidelines are prose; a
// planner emitting a free-form task graph would quietly undo it.

/** More than this and it is not decomposition, it is the model rambling. */
export const MAX_TASKS = 3;

/** Entity buckets the router can actually act on. Anything else is dropped. */
export const ENTITY_TYPES = ['order_numbers', 'products', 'codes'];

/** Offers one email describes, at most. Three is already a complaint about a whole sale. */
export const MAX_OFFER_MENTIONS = 3;

/**
 * Normalises a model's raw decomposition into something safe to route.
 *
 * Never throws and never returns nothing: an unusable answer falls back to ONE
 * task carrying the ticket's own category and kind, which is exactly the
 * behaviour before decomposition existed. Degrading to today's behaviour is
 * always available, so a bad decomposition can slow a ticket down but can never
 * strand it.
 */
export function normaliseDecomposition(raw, ticket = {}) {
  const fallbackCategory = TICKET_SUBJECTS.includes(ticket.category) ? ticket.category : 'other';
  const fallbackKind = REQUEST_KINDS.includes(ticket.request_kind) ? ticket.request_kind : 'question';

  const tasks = [];
  const seen = new Set();

  for (const candidate of Array.isArray(raw?.tasks) ? raw.tasks : []) {
    const question = String(candidate?.question ?? '').replace(/\s+/g, ' ').trim();
    if (!question) continue;

    // Two tasks asking the same thing are one task. Compared case-insensitively
    // because a model asked for sub-questions will happily restate one twice.
    const key = question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    tasks.push({
      question,
      // CLAMPED, not trusted: an unrecognised subject becomes the ticket's own
      // rather than a new value the tool table has no row for.
      category: TICKET_SUBJECTS.includes(candidate?.category) ? candidate.category : fallbackCategory,
      request_kind: REQUEST_KINDS.includes(candidate?.request_kind) ? candidate.request_kind : fallbackKind
    });

    if (tasks.length >= MAX_TASKS) break;
  }

  if (tasks.length === 0) {
    tasks.push({ question: String(ticket.text ?? '').trim(), category: fallbackCategory, request_kind: fallbackKind });
  }

  return { tasks, entities: normaliseEntities(raw?.entities) };
}

/**
 * The extracted entities, cleaned.
 *
 * These are HINTS for the router, never facts. An order number here means "the
 * customer wrote something that looks like an order number", and the resolver
 * still has to confirm it against the order's email hash before anything is
 * written. Getting that wrong is why `shopify_order_number` is only ever set by
 * a confirmed match.
 */
export function normaliseEntities(raw = {}) {
  const out = {};
  for (const type of ENTITY_TYPES) {
    const values = Array.isArray(raw?.[type]) ? raw[type] : [];
    const cleaned = [];
    const seen = new Set();
    for (const value of values) {
      const text = String(value ?? '').trim();
      if (!text || text.length > 120) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push(text);
    }
    out[type] = cleaned;
  }
  out.offers = normaliseOffers(raw?.offers);
  return out;
}

/**
 * The offers the customer described, clamped to the vocabulary
 * `identifyPromotion` matches on. Numbers that are not numbers become null —
 * an absent threshold is "not said", never zero.
 */
export function normaliseOffers(raw) {
  const out = [];
  for (const offer of Array.isArray(raw) ? raw : []) {
    if (!offer || typeof offer !== 'object') continue;
    const number = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);
    const product = String(offer.product ?? '').trim();
    out.push({
      mechanic: DESCRIBED_MECHANIC_KEYS.includes(offer.mechanic) ? offer.mechanic : 'unclear',
      threshold: number(offer.threshold),
      percentage: number(offer.percentage),
      product: product && product.length <= 120 ? product : null
    });
    if (out.length >= MAX_OFFER_MENTIONS) break;
  }
  return out;
}

/**
 * Is decomposing this ticket worth a model call?
 *
 * A single short question is one task by construction, and paying an LLM call to
 * be told so is waste on every ordinary ticket. The signals are deliberately
 * cheap and structural rather than semantic:
 *
 *   - the categoriser already found a SECOND subject, which is the database's
 *     own statement that this email carries two requests;
 *   - the text is long enough to hold more than one question;
 *   - or it contains several question marks.
 */
// THERE IS NO LONGER A GATE ON THIS CALL, and the reason is worth recording.
//
// It used to run only on tickets that looked split (a second subject from the
// categoriser, ≥320 chars, or ≥2 question marks), because paying a model call to
// be told one question is one task is waste. That reasoning was sound for
// splitting alone. It stopped being sound when the same call started declaring
// the ticket's EVIDENCE NEEDS: those have to exist for every investigated
// ticket, or the completeness report has a hole exactly where the short,
// ordinary tickets are — which is most of them.
//
// The cost is one `gpt-4o-mini` call per investigated ticket, against the two
// `gpt-4o` calls the investigation already makes. Investigation runs only on
// ENABLED_SUBJECTS, so it is not paid on forwarded mail, level 4 or `contact`.

// --- from tasks to a run -----------------------------------------------------
//
// Everything below turns the task list into the three things an investigation
// actually needs: which tools exist, which calls run before the model speaks,
// and how big the budget is. None of it can widen a guardrail — every function
// routes through `allowedTools`/`openingMoves`, the same tested table a
// single-task ticket uses.

/**
 * Opening moves are capped so decomposition cannot eat the whole tool budget
 * before the model has said anything. Three tasks × two moves each would.
 */
export const MAX_OPENING_MOVES = 4;

/** Extra tool calls granted per additional task (see `planBudget`). */
const CALLS_PER_EXTRA_TASK = 2;

/**
 * Drops tasks this agent is not allowed to investigate, and says which.
 *
 * DECOMPOSITION MUST NOT BE A BACK DOOR INTO A DISABLED SUBJECT. `delivery` and
 * the rest of the order family have tools defined and tested but are absent from
 * `ENABLED_SUBJECTS` deliberately; a model splitting an email into "product
 * question" + "where is my parcel" must not switch them on by naming one. The
 * skipped tasks are returned rather than discarded so the case file can say a
 * part of the request was not handled — silently ignoring half an email is the
 * one outcome worse than not splitting it.
 */
export function planTasks(ticket = {}, tasks = []) {
  // NOT A SECOND CATEGORISER. When the email was not split, the ticket's own
  // labels stand — the categoriser is the authority on what a ticket is about,
  // it ran on the same text, and it is the value stored, reviewed and reported
  // on. Decomposition may only ever ADD a request, never re-route the one that
  // was already classified.
  if (tasks.length <= 1) {
    return { tasks: [ticketTask(ticket, tasks[0])], skipped: [] };
  }

  const kept = [];
  const skipped = [];

  for (const task of tasks) {
    const investigable =
      ENABLED_SUBJECTS.includes(task.category) &&
      allowedTools(task.category, task.request_kind, ticket.level ?? 1).length > 0;
    (investigable ? kept : skipped).push(task);
  }

  // Every task out of scope: fall back to the ticket's own labels. The caller
  // only investigates tickets that passed `isInvestigable`, so the ticket itself
  // always has tools even when the split landed somewhere it should not.
  if (kept.length === 0) {
    return { tasks: [ticketTask(ticket)], skipped };
  }

  return { tasks: kept, skipped };
}

/** One task carrying the ticket's own labels — the pre-decomposition behaviour. */
function ticketTask(ticket, task = null) {
  return {
    question: task?.question || String(ticket.text ?? '').trim(),
    category: ticket.category,
    request_kind: ticket.request_kind
  };
}

/** The union of every task's allowed tools — never more than the sum of the parts. */
export function planToolNames(ticket = {}, tasks = []) {
  const names = new Set();
  for (const task of tasks) {
    for (const name of allowedTools(task.category, task.request_kind, ticket.level ?? 1)) {
      names.add(name);
    }
  }
  return [...names];
}

/** The evidence checklist, unioned and de-duplicated by key. */
export function planEvidence(tasks = []) {
  const byKey = new Map();
  for (const task of tasks) {
    for (const item of requiredEvidence(task.category)) {
      if (!byKey.has(item.key)) byKey.set(item.key, item);
    }
  }
  return [...byKey.values()];
}

/**
 * The deterministic calls to make before the model's first turn, across tasks.
 *
 * WHICH TEXT EACH TOOL GETS IS THE SUBTLE PART. `openingMoves` passes the whole
 * email, and for a single-task ticket that stays exactly true — this must not
 * change how today's tickets are investigated. Once an email is split, the
 * semantic matchers do better on the sub-question: asking the product matcher
 * about an email that is half about a parcel means competing with the parcel's
 * vocabulary.
 *
 * But only the semantic matchers. `extractPromotionCodes` matches literal codes
 * against the real store list, so it always gets the RAW text: a paraphrase is
 * exactly where a code like BIENVENUE10 stops being present. That distinction is
 * why this rewrites specific tools rather than substituting the text wholesale.
 */
const SEMANTIC_MATCHERS = new Set([TOOL_NAMES.LOOKUP_PRODUCT, TOOL_NAMES.LOOKUP_STOCK]);

export function planMoves(ticket = {}, tasks = [], entities = {}, { limit = MAX_OPENING_MOVES } = {}) {
  const moves = [];
  const seen = new Set();
  const split = tasks.length > 1;

  for (const task of tasks) {
    for (const move of withPromotionMove(ticket, task, entities)) {
      const args =
        split && SEMANTIC_MATCHERS.has(move.tool)
          ? { ...move.args, question: focusedText(task, entities) }
          : move.tool === TOOL_NAMES.IDENTIFY_PROMOTION
            ? promotionArgs(ticket, entities)
            : move.args;

      const key = `${move.tool}:${JSON.stringify(args)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      moves.push({ tool: move.tool, args });

      if (moves.length >= limit) return moves;
    }
  }

  return moves;
}

/**
 * A task's opening moves, plus `identifyPromotion` wherever the customer
 * mentions a code or describes an offer and the task's subject may use it.
 *
 * THIS IS WHERE AN AUTOMATIC-OFFER COMPLAINT FILED UNDER `order` GETS SEEN.
 * Measured 2026-10-01: « le masque offert dès 65 € a été facturé », « frais de
 * port facturés sur 260 € » and their like were filed `order`, `delivery` or
 * `product_stock`, where nothing looked at promotions. The decomposer's own
 * reading decides, so an order ticket that mentions no offer costs nothing.
 */
function withPromotionMove(ticket, task, entities = {}) {
  const scoped = { ...ticket, category: task.category, request_kind: task.request_kind };
  const moves = openingMoves(scoped);
  if (moves.some((move) => move.tool === TOOL_NAMES.IDENTIFY_PROMOTION)) return moves;

  const mentioned = (entities.codes?.length ?? 0) > 0 || (entities.offers?.length ?? 0) > 0;
  const allowed = allowedTools(task.category, task.request_kind, ticket.level ?? 1).includes(TOOL_NAMES.IDENTIFY_PROMOTION);
  return mentioned && allowed ? [...moves, { tool: TOOL_NAMES.IDENTIFY_PROMOTION, args: {} }] : moves;
}

/** The RAW text, as for code extraction, plus what the decomposer read. */
function promotionArgs(ticket, entities = {}) {
  return {
    text: String(ticket.text || ''),
    codes: entities.codes ?? [],
    offers: entities.offers ?? []
  };
}

/** At most this many promotions get an outcome check per ticket. */
export const MAX_OUTCOME_CHECKS = 2;

/**
 * The calls that follow from what the opening moves FOUND.
 *
 * Opening moves are planned before anything runs, so they cannot pass along
 * what identification returns. This is the one deterministic chain: each
 * promotion `identifyPromotion` pinned down — a matched automatic offer by its
 * title, a typed code the shop holds — gets `checkPromotionOutcome`. Having
 * the model ask for it would be a turn spent reaching a foregone conclusion.
 *
 * Nothing is chained from an ambiguous match: checking one of five candidate
 * gifts would evaluate an offer the customer may not mean.
 */
export function followUpMoves(ledger = [], allowedNames = [], { limit = MAX_OUTCOME_CHECKS } = {}) {
  // A TYPED CODE IS LOOKED UP, as extraction once led the model to do. Without
  // it `promotion_validity` stays unknown on a ticket that named its code, and
  // the « aucun code identifié » rule asks the customer for the code they gave.
  const lookups = allowedNames.includes(TOOL_NAMES.LOOKUP_PROMOTION)
    ? [...new Set(ledger.filter((e) => e?.tool === TOOL_NAMES.IDENTIFY_PROMOTION).flatMap((e) => e.data?.knownCodes || []))]
        .slice(0, limit)
        .map((code) => ({ tool: TOOL_NAMES.LOOKUP_PROMOTION, args: { code } }))
    : [];
  if (!allowedNames.includes(TOOL_NAMES.CHECK_PROMOTION_OUTCOME)) return lookups;
  const refs = [];
  for (const entry of ledger) {
    if (entry?.tool !== TOOL_NAMES.IDENTIFY_PROMOTION) continue;
    for (const offer of entry.data?.offers || []) {
      if (offer?.matched?.title) refs.push(offer.matched.title);
      // A gift the customer described but identification could not pin among
      // several: the ORDER may name it, by the free item that was charged. The
      // empty reference asks the tool for exactly that, and nothing else.
      else if (offer?.mechanic === 'gift' && (offer.candidates?.length ?? 0) > 0) refs.push('');
    }
    for (const code of entry.data?.knownCodes || []) refs.push(code);
  }
  return [
    ...lookups,
    ...[...new Set(refs)].slice(0, limit).map((promotion) => ({
      tool: TOOL_NAMES.CHECK_PROMOTION_OUTCOME,
      args: { promotion }
    }))
  ];
}

/**
 * The sub-question plus any product names the customer wrote VERBATIM.
 *
 * The verbatim part matters: the matcher is IDF-weighted over the real wording,
 * and « le masque » in a paraphrase carries none of the weight « Masque LED
 * Hanbang » does. The entities are the one part of the decomposition the model
 * was told to copy rather than rewrite, which is what makes them safe here.
 */
function focusedText(task, entities = {}) {
  return [...(entities.products || []), task.question].join(' ').trim();
}

/**
 * How many tool calls a decomposed run may make.
 *
 * Grows with the task count because two requests genuinely need more evidence
 * than one, and because THIS budget is the cheap one: the tools are cached
 * database reads, while the expensive bound — how many times the model speaks —
 * is `maxTurns` and does not move. Holding tool calls fixed would just mean the
 * second half of an email gets investigated with whatever the first half left.
 */
export function planBudget(baseMaxToolCalls, taskCount) {
  const extra = Math.max(0, Math.min(taskCount, MAX_TASKS) - 1);
  return baseMaxToolCalls + extra * CALLS_PER_EXTRA_TASK;
}

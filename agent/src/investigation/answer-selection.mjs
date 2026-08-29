import { NEED_KEYS, findingValues, isMoot, needRequires } from './evidence-rules.mjs';

// Which answer the evidence selects — and, because it is the same question,
// which fact to go and establish next.
//
// Pure: answers in, findings in, a decision out. No database, no model, no
// clock. Selection has to be mechanical for the same reason scoring does: an
// LLM asked "does this evidence match this condition?" is a judge marking its
// own homework, and the whole point of a closed findings vocabulary is that code
// can answer it.
//
// THE ANSWER TABLE IS ALSO THE EVIDENCE PLAN, and that is the part worth
// noticing. A need no live answer branches on cannot change which answer is
// selected, so collecting it is a tool call spent to learn nothing. Conversely
// the need that best SPLITS the live set is exactly the one worth collecting
// next. Progressive collection falls out of the answers rather than needing its
// own machinery — and it terminates, which a fixed checklist never does.

/**
 * `{ need: [findings] }` — a conjunction across needs, a disjunction within one.
 *
 * A bare string is accepted and widened to a single-element list, because that
 * is how a condition reads when it has one value and forcing the array form on
 * an author buys nothing.
 *
 * UNKNOWN KEYS AND VALUES ARE DROPPED, not preserved. A condition naming a need
 * that no longer exists, or a finding outside that need's vocabulary, can never
 * match anything — keeping it would produce an answer that silently never fires,
 * which is the failure mode hardest to notice from the outside.
 */
export function normaliseConditions(raw, { warn = () => {} } = {}) {
  const conditions = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return conditions;
  }

  for (const [need, value] of Object.entries(raw)) {
    if (!NEED_KEYS.includes(need)) {
      warn(`unknown need « ${need} » in a condition`);
      continue;
    }
    const allowed = findingValues(need);
    if (!allowed) {
      warn(`need « ${need} » carries no findings, so nothing can branch on it`);
      continue;
    }

    const values = (Array.isArray(value) ? value : [value])
      .map((v) => String(v ?? '').trim())
      .filter((v) => {
        if (allowed.includes(v)) return true;
        warn(`« ${v} » is not a finding of ${need}`);
        return false;
      });

    if (values.length > 0) {
      conditions[need] = [...new Set(values)];
    }
  }

  return conditions;
}

/**
 * Every need the rules in a set branch on.
 *
 * THE ANSWER TABLE IS THE EVIDENCE PLAN, stated as code rather than as a comment.
 * A rule can only fire on a need that was actually scored, and the needs a run
 * scores are the ones the exemplar DECLARED — which are chosen to describe what
 * answering requires, not to enumerate what the policy happens to branch on.
 * D-02 declares `order_identity, order_state, policy_answer` and its rules turn
 * on `photo_evidence`, so scoring only the declared set would leave those rules
 * permanently unmatched: a branch that can never fire, which is the failure this
 * module refuses everywhere else.
 *
 * So the set's own conditions say what to score. Cheap, because scoring reads
 * the ledger that already exists — it calls no tool and costs nothing.
 */
export function needsNamedBy(answers = []) {
  const needs = new Set();
  for (const answer of answers) {
    for (const need of Object.keys(answer?.conditions || {})) {
      needs.add(need);
    }
  }
  return [...needs];
}

/** How deeply a condition commits. More needs named = more specific. */
export function specificity(conditions) {
  return Object.keys(conditions || {}).length;
}

/**
 * Does what we have established satisfy this condition?
 *
 * A need with no finding yet does NOT match. Absence of evidence is not the
 * `unknown` finding — `unknown` means a tool ran and could not pin a value, and
 * an answer written for that case should have to say so explicitly.
 */
export function matches(conditions, findings = {}) {
  return Object.entries(conditions || {}).every(([need, values]) =>
    values.includes(findings[need])
  );
}

/**
 * Could this condition still come true if we keep looking?
 *
 * The difference from `matches` is what makes collection progressive: a
 * condition on a need nothing has established yet is still LIVE, while one
 * contradicted by a finding already in hand is dead and can be struck out
 * without ever collecting the rest of its needs.
 */
export function isLive(conditions, findings = {}) {
  return Object.entries(conditions || {}).every(([need, values]) => {
    const established = findings[need];
    return established === undefined || values.includes(established);
  });
}

/**
 * Selects the answer for an evidence position.
 *
 * TWO AXES, RANKED IN THIS ORDER: the situation first, then the conditions.
 * `situationKey` is what the customer WANTS and the conditions are what is TRUE,
 * and they answer different questions — « où est ma commande » and « il manque
 * un article » are two tickets with identical order facts and different replies,
 * while a cancellation's answer turns on a fulfilment status no phrasing can
 * settle. Naming the situation is the stronger claim, so it wins before depth is
 * counted; otherwise a generic two-condition rule would outrank the rule written
 * for this exact request.
 *
 * MOST SPECIFIC WINS, `priority` breaks the tie. Never first-match-wins alone:
 * that makes authoring order silently load-bearing, so inserting a general
 * answer above a specific one would quietly shadow it.
 *
 * NO MATCH IS A RESULT, NOT AN ERROR. Without a fallback the verdict is `none`
 * and the caller routes to a person — the same direction every other fallback in
 * this pipeline fails in. Silence would make a half-answered ticket look
 * identical to a fully answered one.
 */
export function selectAnswer(answers = [], findings = {}, { situationKey = null } = {}) {
  const usable = answers.filter((a) => a && !a.isFallback);

  const matched = usable
    .filter((answer) => matchesSituation(answer, situationKey) && matches(answer.conditions, findings))
    .sort(
      (a, b) =>
        // A RULE THAT NAMES THE SITUATION OUTRANKS ONE THAT DOES NOT, before
        // conditions are counted at all. Naming it is the more specific claim —
        // "this is what to say about a cancellation" beats "this is what to say
        // about any order that has not shipped" — and without this the two axes
        // would compete on depth, where a generic rule with two conditions would
        // beat the situation-specific rule with one.
        Number(Boolean(b.situationKey)) - Number(Boolean(a.situationKey)) ||
        specificity(b.conditions) - specificity(a.conditions) ||
        (b.priority ?? 0) - (a.priority ?? 0)
    );

  if (matched.length > 0) {
    const [best, runnerUp] = matched;
    // Two answers matching equally deeply with equal priority is an authoring
    // bug, not a decision to make at runtime. Reported rather than resolved by
    // sort order, because sort order here is arbitrary.
    //
    // COMPARED THROUGH `sameDepthAs`, which now includes the situation axis. A
    // rule naming the situation and one that does not are NOT tied even at equal
    // condition depth — the sort has already ranked them, deliberately — and
    // reporting them as ambiguous would refuse to answer precisely where the two
    // axes are working as intended.
    const tied = runnerUp && sameDepthAs(best)(runnerUp);

    if (tied) {
      return { verdict: 'ambiguous', answer: null, candidates: matched.filter(sameDepthAs(best)) };
    }
    return { verdict: 'selected', answer: best, candidates: matched };
  }

  const fallback = answers.find((a) => a?.isFallback) || null;
  return fallback
    ? { verdict: 'fallback', answer: fallback, candidates: [] }
    : { verdict: 'none', answer: null, candidates: [] };
}

const sameDepthAs = (best) => (a) =>
  Boolean(a.situationKey) === Boolean(best.situationKey) &&
  specificity(a.conditions) === specificity(best.conditions) &&
  (a.priority ?? 0) === (best.priority ?? 0);

/**
 * Whether this rule is for the situation in hand.
 *
 * A rule naming no situation applies to every one in its set — that is what
 * makes a shared answer shared. A rule naming one applies only there, and
 * critically it does NOT match when no exemplar was matched at all: `null` is
 * "we do not know what they want", and a rule written for a specific intent must
 * not fire on an unknown one.
 */
function matchesSituation(answer, situationKey) {
  return !answer.situationKey || answer.situationKey === situationKey;
}

/**
 * The answers still reachable given what is established so far.
 *
 * Filtered by situation for the same reason selection is: a rule written for a
 * different intent cannot become this ticket's answer, so letting it drive
 * progressive collection would spend tool calls splitting answers that were
 * never candidates.
 */
export function liveAnswers(answers = [], findings = {}, { situationKey = null } = {}) {
  return answers.filter(
    (a) => a && !a.isFallback && matchesSituation(a, situationKey) && isLive(a.conditions, findings)
  );
}

/**
 * Which fact to establish next — the whole of progressive collection.
 *
 * Picks the need that best SPLITS the live answers, because that is the one that
 * most reduces what is still undecided. A need every live answer agrees on
 * cannot change the outcome however it resolves, so spending a tool call on it
 * is spending it to learn nothing.
 *
 * Returns null when collection should stop: one answer left, no answer left, or
 * nothing collectable that would separate them. That is the termination the
 * worked trace ends on — reached before the tool budget rather than by
 * exhausting it.
 *
 * @param answers    the set's answers, with normalised conditions
 * @param findings   { need: finding } established so far
 * @param available  needs this ticket is allowed to collect (the declared set)
 */
export function nextNeed(answers = [], findings = {}, available = [], { situationKey = null } = {}) {
  const live = liveAnswers(answers, findings, { situationKey });
  if (live.length <= 1) {
    return null;
  }

  // Prerequisite readiness is deliberately NOT a filter here. The most
  // discriminating need is usually the deepest one — eligibility, not identity —
  // and filtering it out because its prerequisite is unmet would leave only
  // needs that discriminate nothing, and collection would stop before it
  // started. So the best need is chosen first and the DAG is walked back
  // afterwards, which is also why identity gets collected at all: no answer
  // branches on it, and the promotion cannot be looked up without it.
  const candidates = available.filter(
    (need) => findings[need] === undefined && !isMoot(need, findings)
  );

  let best = null;
  let bestScore = 0;

  for (const need of candidates) {
    // How many DIFFERENT things the live answers say about this need. Counting
    // answers instead would rank a need every answer agrees on as the best
    // possible split, when in fact it settles nothing; what discriminates is
    // disagreement.
    const signatures = new Set(
      live.map((a) => (a.conditions[need] ? [...a.conditions[need]].sort().join('|') : ''))
    );
    if (signatures.size < 2) continue;

    if (signatures.size > bestScore) {
      bestScore = signatures.size;
      best = need;
    }
  }

  return best === null ? null : firstUnmetPrerequisite(best, findings, available);
}

/**
 * Walks down to the first prerequisite that still has to be established.
 *
 * An UNAVAILABLE prerequisite does not block: an exemplar may declare
 * eligibility without declaring identity, and `orderNeeds` takes the same view —
 * the graph orders what was declared, it does not add to it.
 */
function firstUnmetPrerequisite(need, findings, available, seen = new Set()) {
  if (seen.has(need)) {
    return need;
  }
  seen.add(need);

  for (const prerequisite of needRequires(need)) {
    if (findings[prerequisite] !== undefined) continue;
    if (!available.includes(prerequisite)) continue;
    return firstUnmetPrerequisite(prerequisite, findings, available, seen);
  }
  return need;
}

/**
 * Authoring problems a reviewer should see before an answer set is approved.
 *
 * Runs over the SET rather than a row, because every problem here is a relation
 * between answers: one shadowing another, two that can never be told apart, a
 * position with no answer at all.
 */
export function auditAnswerSet(answers = []) {
  const problems = [];
  const usable = answers.filter((a) => a && !a.isFallback);

  for (const answer of usable) {
    // A rule with neither an intent nor a condition matches every ticket in the
    // set, which is what `is_fallback` means and says out loud.
    if (specificity(answer.conditions) === 0 && !answer.situationKey) {
      problems.push(`${answer.answerKey}: no conditions and no situation — use is_fallback instead`);
    }
    if (answer.ask && answer.route !== 'needs_customer_input') {
      // The schema forbids this pair, so reaching it means a row was built in
      // code rather than read from the table. Same failure either way: a
      // question the drafting stage is not permitted to ask.
      problems.push(`${answer.answerKey}: asks for ${answer.ask} without routing to the customer`);
    }
    if (answer.route === 'answerable') {
      problems.push(`${answer.answerKey}: a rule may never route to answerable`);
    }
  }

  // Two answers with identical conditions can never be told apart.
  const byShape = new Map();
  for (const answer of usable) {
    // The situation is part of the shape: two rules with identical conditions
    // under different situations are not duplicates, they are the point of the
    // second axis.
    const shape = JSON.stringify([
      answer.situationKey ?? null,
      Object.keys(answer.conditions).sort().map((k) => [k, [...answer.conditions[k]].sort()])
    ]);
    if (byShape.has(shape)) {
      problems.push(`${answer.answerKey}: same conditions as ${byShape.get(shape)}`);
    } else {
      byShape.set(shape, answer.answerKey);
    }
  }

  if (answers.filter((a) => a?.isFallback).length > 1) {
    problems.push('more than one fallback in the set');
  }

  return problems;
}

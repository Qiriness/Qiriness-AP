import { NEED_KEYS } from '../investigation/evidence-rules.mjs';

// The checks a rule opens, in order (stage 5 item C of
// codex_plans/Case_State_Plan.md). D-36 « the customer wants out »: first
// `partner: delivery_state` (ask Deret where the parcel is), then
// `support: refund_state`. Declared on `support_answers.checks`, copied onto
// the case file that selects the rule, and walked by the fold.
//
// ONE STEP OPEN AT A TIME. The first opens when the case file selects the rule;
// each next one when the step before it is done (a reading of that owner's
// message, or « Mark done »). « No longer needed » ends the sequence: a person
// has taken the plan over, and opening a refund check after they cancelled the
// Deret one would be the rule overruling them. Steps not yet open are kept as
// `queued`, so the ticket can say what comes next; nothing owes a queued step.
//
// NO DUPLICATES. If the same owner already owes the same need (someone wrote
// « je transmets à Deret » before the investigation ran), that check IS the
// step: the rule adopts it rather than opening a second. One already settled in
// the thread is adopted too, as done: Deret is not asked twice.

export const CHECK_OWNERS = Object.freeze(['support', 'colleague', 'partner']);

/** A rule's sequence is short by design; a longer one is a process, not a rule. */
export const MAX_CHECK_STEPS = 5;

/** `[{ owner, need }]` as stored, keeping only well-formed steps, in order. */
export function normaliseChecks(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((step) => CHECK_OWNERS.includes(step?.owner) && NEED_KEYS.includes(step?.need))
    .map((step) => ({ owner: step.owner, need: step.need }))
    .slice(0, MAX_CHECK_STEPS);
}

/**
 * The problems with a sequence a person is saving, in words for the editor.
 *
 * @param owners who may owe a check in this deployment (`obligationOwners`)
 */
export function checkProblems(value, { owners = CHECK_OWNERS } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return ['Checks must be a list of steps.'];
  const problems = [];
  if (value.length > MAX_CHECK_STEPS) problems.push(`At most ${MAX_CHECK_STEPS} steps.`);
  value.forEach((step, index) => {
    const n = index + 1;
    if (!CHECK_OWNERS.includes(step?.owner)) problems.push(`Step ${n}: choose who owes it.`);
    else if (!owners.includes(step.owner)) {
      problems.push(`Step ${n}: this brand has no ${step.owner === 'partner' ? 'operations partner' : step.owner} in its sender directory.`);
    }
    if (!NEED_KEYS.includes(step?.need)) problems.push(`Step ${n}: choose what is to be checked.`);
  });
  return problems;
}

/** The sequences a case file carries: `[{ answerKey, steps }]`. */
export function sequencesOf(caseFile) {
  const raw = caseFile?.check_sequences ?? caseFile?.exemplar_match?.policy?.check_sequences ?? [];
  return (Array.isArray(raw) ? raw : [])
    .map((sequence) => ({ answerKey: sequence?.answer_key ?? sequence?.answerKey ?? null, steps: normaliseChecks(sequence?.steps) }))
    .filter((sequence) => sequence.answerKey && sequence.steps.length > 0);
}

const stepId = (triggerId, answerKey, index) => `r-${triggerId}-${answerKey}-${index}`;

/**
 * A case file's sequences, started: step 1 opened (or adopted), the rest queued.
 * Returns the new obligations list and the sequences to track.
 */
export function startSequences(obligations, caseFile, { at = null } = {}) {
  let list = [...obligations];
  const tracked = [];
  for (const { answerKey, steps } of sequencesOf(caseFile)) {
    const ids = steps.map((_, index) => stepId(caseFile.trigger_message_id, answerKey, index));
    // The same case file folded twice, or two case files on one trigger.
    if (list.some((o) => o.id === ids[0])) continue;
    const meta = (index) => ({ rule: answerKey, step: index + 1, steps: steps.length });
    steps.forEach((step, index) => {
      list.push({ id: ids[index], owner: step.owner, need: step.need, status: 'queued', opened_by: 'rule', opened_at: null, ...meta(index) });
    });
    const sequence = { ids, current: -1 };
    list = openStep(list, sequence, 0, at);
    tracked.push(sequence);
  }
  return { obligations: list, sequences: tracked };
}

/**
 * Open step `index` of a sequence: adopt a check of the same owner and need
 * that is still open, or one already settled in this thread (« don't ask Deret
 * again when their confirmation is already there », the cheat sheet), or open
 * its own. An adopted settled check counts as the step done, and the next opens.
 */
function openStep(list, sequence, index, at) {
  const own = list.find((o) => o.id === sequence.ids[index]);
  const same = (o) => o.owner === own.owner && o.need === own.need && o.id !== own.id && !o.rule;
  const existing = list.find((o) => same(o) && o.status === 'pending') ?? list.find((o) => same(o) && o.status === 'fulfilled');
  sequence.current = index;
  if (existing) {
    sequence.ids[index] = existing.id;
    return list
      .filter((o) => o.id !== own.id)
      .map((o) => (o.id === existing.id ? { ...o, rule: own.rule, step: own.step, steps: own.steps } : o));
  }
  return list.map((o) => (o.id === own.id ? { ...o, status: 'pending', opened_at: at } : o));
}

/**
 * Moves every sequence on: the next step opens once the current one is done,
 * and a cancelled step drops the steps still queued behind it.
 */
export function advanceSequences(obligations, sequences, { at = null } = {}) {
  let list = obligations;
  for (const sequence of sequences) {
    for (;;) {
      const current = list.find((o) => o.id === sequence.ids[sequence.current]);
      if (!current || sequence.current >= sequence.ids.length - 1) break;
      if (current.status === 'fulfilled') {
        list = openStep(list, sequence, sequence.current + 1, at);
        continue;
      }
      if (current.status === 'cancelled') {
        const rest = new Set(sequence.ids.slice(sequence.current + 1));
        list = list.filter((o) => !(rest.has(o.id) && o.status === 'queued'));
        sequence.current = sequence.ids.length - 1;
      }
      break;
    }
  }
  return list;
}

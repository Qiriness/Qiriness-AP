import { LABELS_STILL_VALID } from '../../../scripts/lib/case-state-record.mjs';
import { MISSING_FIELDS } from '../investigation/case-file.mjs';
import { NEED_KEYS, needsSatisfiedBy } from '../investigation/evidence-rules.mjs';

// The decisions the Case Manager makes in CODE, once the model has read the
// message.
//
// THE SPLIT THIS FILE EXISTS FOR. The model reads prose and picks from a closed
// vocabulary — which relationship, which questions this message answered. What
// those choices MEAN for the pipeline is decided here, in pure functions, for
// the same reason `evidence-rules.mjs` owns what satisfies a need: a model
// asked both questions is marking its own homework, and the second answer
// cannot then be used to check the first.
//
// NOTHING HERE DECIDES WHAT A REPLY SAYS. It decides whether the categoriser
// re-runs, which situation the case is in, and which prior evidence may be
// reused. The verdict, the rules and the reply are all downstream and unchanged.

/**
 * Should the categoriser re-read this thread's labels?
 *
 * RE-CATEGORISATION IS DELIBERATE AND MEASURED — « a ticket's labels describe
 * the conversation so far, not the email that opened it » (DECISIONS §
 * Re-categorisation is blind). It is also what maintains `secondary_category`,
 * the axis that opens a second rulebook on **66 of 309 investigable tickets
 * (21%)**. So this suppresses it on ONE relationship and lets it run on the
 * other three.
 *
 * `continuation` IS THE ONLY SAFE ONE. The same request, moved along: the
 * subject, the kind and the second axis all still describe the thread, and
 * re-deriving them spends a call to write down what is already there.
 * `new_information` may have changed what the thread is about, `new_issue`
 * certainly has, and `unclear` is the case where nothing should be skipped on
 * the strength of a reading that failed.
 *
 * THE SAVING IS NOT THE POINT, and it is worth saying so: one `gpt-4o-mini`
 * call is the cheapest thing in the poll. What this buys is the LABELS not
 * moving under a case that has not changed — a re-categorisation is blind by
 * design, so on a courtesy follow-up it can only ratchet the level or rewrite a
 * subject that was right.
 */
export function shouldRecategorise(caseRelationship) {
  return !LABELS_STILL_VALID.includes(caseRelationship);
}

/**
 * Which situation the case is in, now.
 *
 * STICKY BY DEFAULT, which closes a question `DECISIONS.md` left open: « what a
 * later message should do to a situation already matched is undecided ». The
 * matcher scores the OPENING message, so on a follow-up it re-derives the same
 * answer at the cost of an embedding and, on a near miss, a chooser call.
 *
 * `new_issue` DROPS IT, because a second request inside a thread is what the
 * classifier exists for and carrying the old situation into it would answer the
 * new question from the old case's rules.
 *
 * A STICKY MATCH THAT WAS WRONG STAYS WRONG, and that is the cost. It is
 * bounded: a person editing the rulebook can change what the situation does,
 * and the next `new_issue` re-matches. The alternative — re-matching every run —
 * lets a courtesy note redefine what a ticket is about, which is the failure
 * the opening-message rule was introduced to stop.
 */
export function situationFor({ caseRelationship, previousSituationKey } = {}) {
  if (caseRelationship === 'new_issue') return null;
  return previousSituationKey ?? null;
}

/**
 * How the investigation gets its situation for the message it is about to read.
 *
 * `{ carry }` — the case state holds a situation: reuse it, and skip the
 *   matcher. The previous run's match is carried whole when it is for the same
 *   key, because its `requirement_needs` are the fallback the decomposer leans
 *   on; a key that arrived some other way carries none rather than a guess.
 * `{ match: 'trigger' }` — the Case Manager read THIS message as a second
 *   request. The opening message describes the first one, so matching it again
 *   would answer the new question from the old case's rules; the new request is
 *   what gets matched.
 * `{ match: 'opening' }` — everything else: a first message, a case state with
 *   no situation in it, or no case state at all. Exactly what ran before the
 *   case state existed.
 *
 * `new_issue` COUNTS ONLY WHEN IT IS ABOUT THIS MESSAGE. An older reading that
 * said `new_issue` was acted on by the investigation of that message; the case
 * state after it carries whatever that run matched.
 */
export function situationPlan({ reading = null, triggerMessageId = null, previousMatch = null } = {}) {
  if (!reading) return { match: 'opening' };
  if (reading.case_relationship === 'new_issue' && reading.trigger_message_id === triggerMessageId) {
    return { match: 'trigger' };
  }
  const key = reading.situation_key ?? null;
  if (!key) return { match: 'opening' };
  const same = previousMatch?.exemplar_key === key;
  const { tied: _tied, ...previous } = same ? previousMatch : {};
  return {
    carry: {
      ...previous,
      verdict: same ? previous.verdict : 'carried',
      exemplar_key: key,
      requirement_needs: same ? previous.requirement_needs ?? [] : []
    }
  };
}

/**
 * Whether the order the case is about is not the one the last run looked at.
 *
 * `context_ref.orderName` is the confirmed number the previous investigation
 * ran against. A different one now — a correction, a person linking the right
 * order, an order confirmed after the run — makes every order-derived finding
 * about the wrong parcel. No number before and one now counts as changed: the
 * earlier run's order facts were about a candidate at best.
 */
export function orderChangedSince({ contextRef = null, currentOrderName = null } = {}) {
  return (contextRef?.orderName ?? null) !== (currentOrderName ?? null);
}

/**
 * Which questions are still outstanding after this message.
 *
 * THE POINT OF THE WHOLE TABLE. A question recorded when it is asked, and
 * struck off when it is answered, is a fact; the same question recovered from
 * our own sent prose afterwards is a guess that measured 2.4 false hits per
 * thread (DECISIONS § A re-ask guardrail was built, measured, and removed).
 *
 * KEYS ONLY, CHECKED AGAINST `MISSING_FIELDS`. The model says which of OUR
 * questions this message answered; anything it invents is dropped, because a
 * key nothing downstream recognises would silently fail to suppress anything.
 */
export function pendingAfter({ previousPending = [], resolvedInputs = [], newlyMissing = [] } = {}) {
  const resolved = new Set(known(resolvedInputs));
  const carried = known(previousPending).filter((field) => !resolved.has(field));
  return [...new Set([...carried, ...known(newlyMissing).filter((field) => !resolved.has(field))])];
}

function known(fields) {
  return (Array.isArray(fields) ? fields : [])
    .map((entry) => (typeof entry === 'string' ? entry : entry?.field))
    .filter((field) => typeof field === 'string' && Object.hasOwn(MISSING_FIELDS, field));
}

/**
 * Whether a previous run's answer to a need may stand.
 *
 * FOUR STATES, AND ONLY TWO OF THEM ARE INTERESTING. `missing` is the ordinary
 * case on a first reading and `valid` is the ordinary case on a follow-up;
 * `invalidated` and `stale` are the ones that cost a tool call.
 *
 * `invalidated` IS THE RULE THAT EARNS ITS KEEP TODAY. The customer corrects an
 * order number, a person links the right order, and every answer derived from
 * the old one is about a different order. `argsHash` is already on every stored
 * ledger entry, so this is a comparison and not an inference —
 * `reinvestigationColumns` is the existing precedent for the same idea at the
 * ticket level.
 *
 * `stale` IS DELIBERATELY NARROW, AND THERE IS NO TTL TABLE. Measured across
 * all 2,006 orders: `dispatched_no_scan` **1,992 (99%)**, `in_transit` **0**,
 * `stale_in_transit` **0**. There is no carrier feed, so a freshness policy on
 * tracking would re-ask a question whose answer cannot have changed, and six
 * rules are already dormant for that reason. The one honest staleness lever is
 * the order bundle, which has its own refresh (`context:build --refresh`).
 *
 * REPORTED, NOT ENFORCED — like the evidence needs before it. Nothing here
 * skips a tool call. It is stored on `ticket_case_state.evidence_reuse` and, as
 * of 2026-09-25, READ BY NOTHING: an earlier version of this comment said `valid`
 * reached the investigation, and it never did. Handing it over is the next step
 * of the investigation delta; suppression is a separate decision after that,
 * with its own replay, because acting here would mean acting on a signal
 * nothing has measured.
 */
export const REUSE_STATES = ['valid', 'stale', 'invalidated', 'missing'];

/** Needs whose answer moves on its own, and so cannot be reused across runs. */
const DYNAMIC_NEEDS = new Set(['order_state', 'delivery_state', 'dispatch_state', 'delivery_delay_state']);

export function reuseState({ entry, currentArgsHash = null, orderChanged = false } = {}) {
  if (!entry || !entry.tool) return 'missing';
  if (orderChanged && ORDER_DERIVED.has(entry.need)) return 'invalidated';
  if (currentArgsHash && entry.argsHash && currentArgsHash !== entry.argsHash) return 'invalidated';
  if (DYNAMIC_NEEDS.has(entry.need)) return 'stale';
  return 'valid';
}

/**
 * Needs whose answer is ABOUT the order, so a different order invalidates them.
 *
 * Derived from the evidence vocabulary rather than listed by hand, so a need
 * added there cannot be silently left out of the invalidation.
 */
const ORDER_DERIVED = new Set(
  NEED_KEYS.filter((need) => need.startsWith('order_') || need.startsWith('delivery_') ||
    ['dispatch_state', 'payment_state', 'refund_state', 'return_eligibility'].includes(need))
);

/**
 * The prior run's ledger, reduced to what may be carried forward.
 *
 * OUTCOME BUCKETS ONLY. `{ need, tool, argsHash, outcome, run_at, status }` and
 * never what the tool returned: `ticket_investigations.tool_calls` drops `data`
 * on purpose and `context_ref` points at `resolved_context` rather than copying
 * it, both so personal data is not duplicated per run. Reusing the CONTENT of a
 * previous call would reopen that; reusing the knowledge that it ran does not.
 */
export function evidenceReuseFrom({ toolCalls = [], findings = {}, orderChanged = false, runAt = null } = {}) {
  // WHICH CALL ANSWERED WHICH NEED IS NOT ON THE LEDGER, and expecting it there
  // was this function's first bug: a stored entry is `{id, tool, argsHash,
  // outcome}` and carries no need, so a join on one matched nothing and every
  // need read `missing`. The mapping belongs to the evidence vocabulary
  // (`needsSatisfiedBy`), which already knows which tools can settle a need —
  // deriving it there means a tool added to a need cannot be forgotten here.
  //
  // THE LAST CALL WINS where several could have settled the same need. It is the
  // one whose `argsHash` describes the arguments in force at the end of the run,
  // which is what `invalidated` compares against.
  const callFor = new Map();
  for (const entry of toolCalls) {
    if (!entry?.tool) continue;
    for (const need of needsSatisfiedBy(entry.tool)) callFor.set(need, entry);
  }

  const byNeed = {};
  for (const [need, finding] of Object.entries(findings)) {
    // `unknown` means the run looked and could not settle it, which is not a
    // fact worth carrying: the next run should look again rather than inherit
    // an absence of an answer as though it were one.
    if (!finding || finding === 'unknown') continue;
    const call = callFor.get(need) ?? null;
    byNeed[need] = {
      need,
      tool: call?.tool ?? null,
      argsHash: call?.argsHash ?? null,
      outcome: call?.outcome ?? null,
      finding,
      run_at: runAt,
      status: reuseState({ entry: { ...call, need }, orderChanged })
    };
  }
  return byNeed;
}

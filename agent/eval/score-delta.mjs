import { needsSatisfiedBy } from '../src/investigation/evidence-rules.mjs';

// What a follow-up investigation did with the case delta it was given.
//
// PURE. Reads one run's stored ledger against the delta it started from.
//
// THE TWO QUESTIONS THE DELTA MAKES MEASURABLE, and they pull in opposite
// directions. Did the MODEL look up again something the section said was
// established (the saving the delta exists for)? And was every fact marked to
// refresh actually looked at again (the safety it must not cost)? A delta that
// cut calls by skipping refreshes would score well on the first and be wrong.
//
// ONLY THE MODEL'S CALLS COUNT AS RE-FETCHES. Opening moves run on every run by
// design and the planner follows the rules; neither read the section, so
// charging their calls to it would measure the pipeline, not the prompt.
// Refreshes count from any source — a stale fact looked at is looked at.

export function scoreDeltaRun({ delta, toolCalls = [] }) {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  const bySource = {};
  for (const call of calls) {
    const source = call?.source ?? 'unknown';
    bySource[source] = (bySource[source] ?? 0) + 1;
  }

  const established = new Set((delta?.established ?? []).map((row) => row.need));
  const refetched = new Set();
  for (const call of calls) {
    if (call?.source !== 'model') continue;
    for (const need of needsSatisfiedBy(call.tool)) {
      if (established.has(need)) refetched.add(need);
    }
  }

  const touched = new Set(calls.flatMap((call) => needsSatisfiedBy(call?.tool)));
  const toRefresh = (delta?.toRefresh ?? []).map((row) => row.need);

  return {
    calls: calls.length,
    bySource,
    refetchedEstablished: [...refetched].sort(),
    staleRefreshed: toRefresh.filter((need) => touched.has(need)).sort(),
    staleMissed: toRefresh.filter((need) => !touched.has(need)).sort()
  };
}

/**
 * Whether this investigation ran with a delta: a Case Manager reading on the
 * same trigger message, written before the run. Derived, not stored — the
 * worker writes both rows already, and a flag would be a third place to agree.
 */
export function ranWithDelta({ investigation, reading }) {
  if (!investigation || !reading) return false;
  if (reading.trigger_message_id !== investigation.trigger_message_id) return false;
  if (!reading.read_at || !investigation.investigated_at) return false;
  return new Date(reading.read_at) <= new Date(investigation.investigated_at);
}

import { policiesFor } from '../../../scripts/lib/company-policies.mjs';

import { TOOL_NAMES } from './investigation-rules.mjs';

// Which company policies a case read, and why: the record on
// `ticket_investigations.company_policies` that drafting reads the policies
// back from. Pure. DECISIONS.md § Company policies.
//
//   situation — linked to a situation one of the email's requests matched;
//   rule      — linked to a rule the evidence selected;
//   agent     — fetched by the model with getPolicy, for something else it was asked.
//
// A policy linked twice is recorded once, under the first reason in that order.

/** The (answer set, rule key) pairs the selection chose, one per request. */
function selectedRules(selection) {
  if (!selection) return [];
  if (Array.isArray(selection.per_request)) {
    return selection.per_request.filter((p) => p.answer_key).map((p) => [p.answer_set, p.answer_key]);
  }
  return selection.answer_key ? [[selection.answer_set, selection.answer_key]] : [];
}

/**
 * @param library   `{ policies, links }` as the registry loaded it
 * @param requests  the email's requests: `{ answerSet, situationKey, answers: [{ id, answerKey }] }`
 * @param selection the case file's rule selection (`exemplar_match.policy` shape), or null
 * @param ledger    the run's tool calls: getPolicy entries carry `data: { key, version }`
 * @returns `[{ key, version, source }]`
 */
export function companyPoliciesUsed({ library, requests = [], selection = null, ledger = [] }) {
  const out = [];
  const seen = new Set();
  const add = (policy, source) => {
    if (!policy || seen.has(policy.policy_key)) return;
    seen.add(policy.policy_key);
    out.push({ key: policy.policy_key, version: policy.version ?? null, source });
  };

  for (const situationKey of new Set(requests.map((r) => r.situationKey).filter(Boolean))) {
    for (const { policy } of policiesFor(library, { situationKey })) add(policy, 'situation');
  }

  const answerIds = [];
  for (const [answerSet, answerKey] of selectedRules(selection)) {
    const request = requests.find((r) => r.answerSet === answerSet) ?? null;
    const answer = (request?.answers ?? []).find((a) => a.answerKey === answerKey) ?? null;
    if (answer?.id) answerIds.push(answer.id);
  }
  for (const { policy, source } of policiesFor(library, { answerIds })) if (source === 'rule') add(policy, 'rule');

  for (const entry of ledger) {
    if (entry?.tool !== TOOL_NAMES.GET_POLICY || entry.outcome !== 'found') continue;
    const policy = (library?.policies ?? []).find((p) => p.policy_key === entry.data?.key);
    add(policy ? { ...policy, version: entry.data?.version ?? policy.version } : null, 'agent');
  }
  return out;
}

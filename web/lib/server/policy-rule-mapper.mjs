import { answerFromRow } from '../../../agent/src/investigation/answer-selection.mjs';

/**
 * Maps one stored support rule into the dashboard contract.
 *
 * The agent owns the executable rule shape. Reusing `answerFromRow` here keeps
 * the Rulebook on the same current findings vocabulary, including when a data
 * migration temporarily retains a legacy value for deployment compatibility.
 */
export function mapPolicyRule(row = {}) {
  const answer = answerFromRow(row);

  return {
    id: String(row.id),
    answerSet: String(row.answer_set),
    answerKey: String(answer.answerKey),
    situationKey: answer.situationKey,
    conditions: answer.conditions,
    answerSkeleton: answer.answerSkeleton,
    route: answer.route,
    ask: answer.ask,
    offerCode: answer.offerCode,
    knowledgeDocumentId: answer.knowledgeDocumentId,
    tones: answer.tones,
    link: answer.link,
    checks: answer.checks,
    priority: Number(answer.priority ?? 0),
    isFallback: answer.isFallback,
    approvalStatus: String(row.approval_status ?? 'draft'),
    updatedAt: row.updated_at ?? null
  };
}

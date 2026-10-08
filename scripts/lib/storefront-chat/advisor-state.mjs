/**
 * The consultation's memory between turns, folded out of the message log —
 * the same pattern as `refs` (conversation-refs.mjs): each assistant row stores
 * `context.advisor`, and the next turn reads the latest one. No table.
 *
 *   { profile, mode, asked: [field], last_question: field | null,
 *     last_advice: { status, playbook, scope, product_ids } | null }
 *
 * The log is the public internet's input once removed: everything is
 * re-checked here, and the profile is re-validated by `mergeProfile` on use.
 */

export const MODES = ['conversation', 'routine_builder'];

export function emptyAdvisorState() {
  return { profile: {}, mode: 'conversation', asked: [], last_question: null, last_advice: null };
}

const FIELD = /^[a-z_]{1,40}$/;

export function advisorStateFromHistory(history = []) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const row = history[i];
    const saved = row?.role === 'assistant' ? row.context?.advisor : null;
    if (saved && typeof saved === 'object') return clean(saved);
  }
  return emptyAdvisorState();
}

function clean(saved) {
  const profile = saved.profile && typeof saved.profile === 'object' && !Array.isArray(saved.profile) ? saved.profile : {};
  const advice = saved.last_advice && typeof saved.last_advice === 'object' ? saved.last_advice : null;
  return {
    profile: Object.fromEntries(Object.entries(profile).filter(([k, v]) => FIELD.test(k) && v && typeof v === 'object')),
    mode: MODES.includes(saved.mode) ? saved.mode : 'conversation',
    asked: Array.isArray(saved.asked) ? saved.asked.filter((f) => typeof f === 'string' && FIELD.test(f)).slice(0, 20) : [],
    last_question: typeof saved.last_question === 'string' && FIELD.test(saved.last_question) ? saved.last_question : null,
    last_advice: advice
      ? {
          status: typeof advice.status === 'string' ? advice.status : null,
          playbook: typeof advice.playbook === 'string' ? advice.playbook : null,
          scope: typeof advice.scope === 'string' ? advice.scope : null,
          product_ids: Array.isArray(advice.product_ids) ? advice.product_ids.filter((id) => typeof id === 'string').slice(0, 12) : []
        }
      : null
  };
}

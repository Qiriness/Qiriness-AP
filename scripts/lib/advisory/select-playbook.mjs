/**
 * Which playbook — and, for playbooks with routes, which route — answers this
 * profile, following the shop's `selection_priority`:
 *
 *   body_area → primary_concern   the only GATES
 *   then skin behaviour, sensitivity, secondary concerns   DISTINGUISHERS between candidates
 *   sex_target                     chooses the men's playbook only when explicit
 *   age                            NEVER selects a playbook (rule 6)
 *
 * Two genuinely plausible playbooks are not decided here: the result is
 * `ambiguous`, with the concerns that tell them apart, for ONE question
 * (`ambiguity_rule`).
 */

import { NO_MATCH } from './reason-codes.mjs';
import { valueOf } from './profile.mjs';

export const concernsOf = (p) => [...(p.primary_concerns ?? []), ...(p.routes ?? []).flatMap((r) => r.concerns ?? [])];

/**
 * @returns {{ status: 'selected', playbook: object, route: object | null, inferredArea: string | null }
 *   | { status: 'missing' | 'ambiguous', field: string, options: string[], candidates: string[] }
 *   | { status: 'no_match', reason: string }}
 */
export function selectPlaybook(profile, raw) {
  const area = valueOf(profile, 'body_area');
  const primary = valueOf(profile, 'primary_concern');
  const men = valueOf(profile, 'sex_target') === 'men';
  const secondary = valueOf(profile, 'secondary_concerns') ?? [];
  const behaviours = valueOf(profile, 'skin_behaviour') ?? [];
  const sensitive = ['sensitive', 'reactive'].includes(valueOf(profile, 'sensitivity'));

  // Target: the men's playbooks only on an explicit men's request (rule 4);
  // otherwise only the main ones (rule 5).
  const forTarget = (list) => list.filter((p) => (men ? p.target === 'men' : !p.target));
  let pool = forTarget(raw.playbooks);
  if (men && area) pool = pool.filter((p) => p.area === area);
  // No men's playbook for this area: the main playbooks, with men's products only (eligibility).
  if (men && !pool.length) pool = raw.playbooks.filter((p) => !p.target);

  if (!primary) {
    const inArea = area ? pool.filter((p) => p.area === area) : pool;
    if (!inArea.length) return { status: 'no_match', reason: NO_MATCH.NO_PLAYBOOK_FOR_AREA };
    return { status: 'missing', field: 'primary_concern', options: representativeConcerns(inArea), candidates: inArea.map((p) => p.key) };
  }

  let candidates = pool.filter((p) => concernsOf(p).includes(primary));
  if (!candidates.length) return { status: 'no_match', reason: NO_MATCH.NO_PLAYBOOK };
  if (area) {
    candidates = candidates.filter((p) => p.area === area);
    if (!candidates.length) return { status: 'no_match', reason: NO_MATCH.NO_PLAYBOOK_FOR_AREA };
  } else {
    const areas = [...new Set(candidates.map((p) => p.area))];
    // A skin type (sèche, mixte, grasse) describes the face: « peau déshydratée
    // et mixte » is not a question about the body.
    if (areas.length > 1 && areas.includes('face') && valueOf(profile, 'skin_type')) candidates = candidates.filter((p) => p.area === 'face');
    else if (areas.length > 1) return { status: 'ambiguous', field: 'body_area', options: areas, candidates: candidates.map((p) => p.key) };
  }
  const inferredArea = area ? null : candidates[0].area;

  let chosen = candidates[0];
  if (candidates.length > 1) {
    // Distinguishers only: what else the customer said about their skin.
    const known = new Set([...secondary, ...behaviours]);
    const scored = candidates.map((p) => ({
      p,
      score: concernsOf(p).filter((c) => c !== primary && known.has(c)).length + (sensitive && p.tolerance_first ? 1 : 0)
    }));
    const best = Math.max(...scored.map((s) => s.score));
    const top = scored.filter((s) => s.score === best).map((s) => s.p);
    if (top.length > 1) {
      return { status: 'ambiguous', field: 'primary_concern', options: distinguishingConcerns(top, primary), candidates: top.map((p) => p.key) };
    }
    chosen = top[0];
  }

  let route = null;
  if (chosen.routes?.length) {
    route = chosen.routes.find((r) => (r.concerns ?? []).includes(primary))
      ?? chosen.routes.find((r) => (r.concerns ?? []).some((c) => secondary.includes(c)))
      ?? null;
    if (!route) return { status: 'missing', field: 'primary_concern', options: chosen.routes.map((r) => r.concerns?.[0]).filter(Boolean), candidates: [chosen.key] };
  }
  return { status: 'selected', playbook: chosen, route, inferredArea };
}

/**
 * One concern per playbook, so « what bothers you most? » has a handful of
 * real choices: the playbook's `distinguish_by` first (how the shop wants it
 * asked), else its first concern.
 */
function representativeConcerns(playbooks) {
  const out = [];
  for (const p of playbooks) {
    const first = p.routes?.length ? p.routes.map((r) => r.concerns?.[0]) : [p.distinguish_by?.[0] ?? p.primary_concerns?.[0]];
    for (const c of first) if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * Concerns that belong to exactly one of the tied playbooks, one per playbook
 * in turn, `distinguish_by` first: « Perte de fermeté » against « Signes de
 * l'âge globaux », not against « Fermeté ».
 */
function distinguishingConcerns(playbooks, primary) {
  const unique = (c) => c !== primary && playbooks.filter((q) => concernsOf(q).includes(c)).length === 1;
  const lists = playbooks.map((p) => [...new Set([...(p.distinguish_by ?? []), ...concernsOf(p)])].filter(unique));
  const out = [];
  for (let i = 0; out.length < 4 && lists.some((l) => l.length > i); i += 1) {
    for (const l of lists) if (l[i] && out.length < 4) out.push(l[i]);
  }
  return out;
}

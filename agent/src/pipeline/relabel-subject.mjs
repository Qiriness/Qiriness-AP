import { defaultLevel, defaultTeam, ratchetLevel } from '../../../scripts/lib/support-taxonomy.mjs';
import { overridesOf } from '../../../scripts/lib/ticket-overrides.mjs';

// What a one-off subject backfill may change on a ticket that already carries
// labels, given a fresh reading by the categoriser.
//
// Pure: a ticket and a categorisation in, a patch (or null) out. The CLI that
// reads the tickets and writes the patch is agent/src/tools/run-relabel-subject.mjs.
//
// WHY A BACKFILL AND NOT A RE-CATEGORISATION. Raising `needs_categorisation`
// would re-read every thread through the normal pass, which then raises
// `needs_investigation` — re-running investigation and drafting on threads
// where nothing new arrived (« re-delivery is not arrival »). Closed tickets
// are not even in that pass's queue. So the categoriser is called directly,
// and only the labels are written: no flag moves.
//
// ONLY THE NEW SUBJECT IS APPLIED. A fresh blind reading also drifts on things
// nobody asked to change (another subject, a secondary, a happiness score);
// writing those would rewrite history to settle a question that was not asked.
// The reading is used for one decision — is this the target subject? — and
// everything else on the ticket stays as it was.

/**
 * @param ticket  { category, request_kind, secondary_category,
 *                  secondary_request_kind, level, responsible_team, metadata,
 *                  overrides }
 * @param result  normaliseCategorisation() output, plus `model`
 * @param target  the subject being backfilled, e.g. 'defective_product'
 * @returns {{ change: 'primary'|'secondary', columns: object, trail: object } | null}
 */
export function relabelPatch(ticket, result, { target, at = new Date().toISOString(), by } = {}) {
  if (!ticket || !result || !target) return null;
  if (ticket.category === target || ticket.secondary_category === target) return null;

  // A PERSON'S CORRECTION STAYS. A subject someone set by hand on the
  // dashboard is not the categoriser's to move, here or in the live pass.
  if (overridesOf(ticket).category) return null;

  const levelOverride = overridesOf(ticket).level;
  const modelLevel = levelOverride ? levelOverride.ai_value ?? null : ticket.level;

  let change = null;
  let columns = null;
  if (result.category === target) {
    change = 'primary';
    const kind = result.request_kind;
    // The ticket's secondary survives unless it is now the primary's twin.
    const keepSecondary = ticket.secondary_category && ticket.secondary_category !== target;
    columns = {
      category: target,
      request_kind: kind,
      secondary_category: keepSecondary ? ticket.secondary_category : null,
      secondary_request_kind: keepSecondary ? ticket.secondary_request_kind ?? null : null,
      level: ratchetLevel(modelLevel, Math.max(result.level, defaultLevel(target, kind))),
      responsible_team: overridesOf(ticket).responsible_team ? ticket.responsible_team : defaultTeam(target)
    };
  } else if (result.secondary_category === target && ticket.secondary_category === 'product') {
    // The defect was the SECOND request of the thread, and the ticket already
    // said so under the old subject: only that pair moves.
    change = 'secondary';
    const kind = result.secondary_request_kind ?? 'problem';
    columns = {
      secondary_category: target,
      secondary_request_kind: kind,
      level: ratchetLevel(modelLevel, defaultLevel(target, kind))
    };
  }
  if (!columns) return null;

  // The ratchet is a rule about the model; a person's lower level stays.
  if (levelOverride) delete columns.level;

  const superseded = {
    category: ticket.category ?? null,
    request_kind: ticket.request_kind ?? null,
    level: ticket.level ?? null,
    happiness: ticket.happiness ?? null,
    at: ticket.metadata?.categorisation?.at ?? null
  };
  const history = Array.isArray(ticket.metadata?.categorisation?.history) ? ticket.metadata.categorisation.history : [];

  return {
    change,
    columns,
    trail: {
      history: [superseded, ...history].slice(0, 5),
      relabelled: { to: target, change, by: by ?? null, model: result.model ?? null, reason: result.reason ?? null, at }
    }
  };
}

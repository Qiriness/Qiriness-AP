// What a person's correction of a ticket does, whoever reads it.
//
// Pure: the ticket's `overrides` column and the change in, columns and rules
// out. The dashboard writes overrides; the categoriser, the fold, the status
// rule and the situation planner read them. The field classes live here once,
// so « does this change stale the draft » cannot be answered two ways.
//
// It lives in `scripts/lib` because `web/` and `agent/` both read it, and it has
// node tests here because `web/` has no test runner (the order-link.mjs rule).
//
// THE AI VALUE IS NEVER LOST. `tickets.<column>` holds the EFFECTIVE value, so
// every existing reader (the queue, the investigation, the draft gate) keeps
// reading the column it always read. What the pipeline would have said is kept
// in `overrides.<field>.ai_value`, and the categoriser keeps it current.

import { reinvestigationColumns } from './order-link.mjs';
import { TICKET_SUBJECTS } from './support-taxonomy.mjs';

/** Every field a person may override. Assignee and the linked customer are not here, by decision. */
export const OVERRIDE_FIELDS = Object.freeze(['situation', 'category', 'level', 'status', 'responsible_team', 'priority']);

/** Change what the investigation reads: a Save touching one queues it again. */
export const MEANING_FIELDS = Object.freeze(['situation', 'category']);

/** Change whether and how a reply goes out (level 4 is silent, level decides auto-send). */
export const GATE_FIELDS = Object.freeze(['level']);

/** The fields whose override raises `case_current.version`, staling drafts written before it. */
export const VERSION_FIELDS = Object.freeze([...MEANING_FIELDS, ...GATE_FIELDS]);

/** Written straight to a ticket column; `situation` and `priority` live only in `overrides`. */
export const COLUMN_FIELDS = Object.freeze(['category', 'level', 'status', 'responsible_team']);

/** The fields the categoriser writes, and so the ones whose AI value it keeps current. */
export const CATEGORISER_FIELDS = Object.freeze(['category', 'level', 'responsible_team']);

/** The statuses a person sets, as `setTicketStatus` already allows. */
export const PERSON_STATUSES = Object.freeze(['open', 'resolved', 'closed']);

export const PRIORITY_BANDS = Object.freeze(['high', 'medium', 'low']);

export const RESPONSIBLE_TEAMS = Object.freeze(['finance', 'marketing', 'sales', 'logistics', 'contact']);

/** Where the override came from. Recorded, never branched on. */
export const OVERRIDE_SOURCES = Object.freeze(['edit_case', 'closest_situation', 'quick_edit']);

/** The overrides column as an object, whatever was stored. */
export function overridesOf(ticket) {
  const raw = ticket?.overrides;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

/** The value a person set, or undefined. */
export function overrideValue(ticket, field) {
  const entry = overridesOf(ticket)[field];
  return entry && Object.hasOwn(entry, 'value') ? entry.value : undefined;
}

/**
 * A value a person typed, checked against the field's vocabulary. Null when it
 * is not one: the caller refuses rather than storing a guess.
 */
export function validOverrideValue(field, raw) {
  if (field === 'situation') {
    const key = String(raw ?? '').trim();
    return /^[A-Z]{1,3}-\d{1,3}$/.test(key) ? key : null;
  }
  if (field === 'category') return TICKET_SUBJECTS.includes(raw) ? raw : null;
  if (field === 'level') {
    const level = Number(raw);
    return Number.isInteger(level) && level >= 1 && level <= 4 ? level : null;
  }
  if (field === 'status') return PERSON_STATUSES.includes(raw) ? raw : null;
  if (field === 'responsible_team') return RESPONSIBLE_TEAMS.includes(raw) ? raw : null;
  if (field === 'priority') return PRIORITY_BANDS.includes(raw) ? raw : null;
  return null;
}

/**
 * What the version turns on, or null when no version field is overridden.
 *
 * NULL, NOT `{}`, WHEN THERE IS NOTHING. The fold adds this to the material
 * hash only when present; an empty object would change the hash of every
 * ticket in the shop at once, raise every version and stale every open draft.
 */
export function versionMaterial(overrides) {
  const material = {};
  for (const field of VERSION_FIELDS) {
    const entry = overrides?.[field];
    if (entry && Object.hasOwn(entry, 'value')) material[field] = entry.value;
  }
  return Object.keys(material).length > 0 ? material : null;
}

/**
 * Whether a person's status still holds: it does until the customer writes
 * again after it was set. Then the case is new information and the fold decides.
 */
export function statusHeld(overrides, lastCustomerAt) {
  const setAt = Date.parse(overrides?.status?.set_at ?? '');
  if (Number.isNaN(setAt)) return false;
  const wrote = Date.parse(lastCustomerAt ?? '');
  return Number.isNaN(wrote) || wrote <= setAt;
}

/**
 * The situation a person chose, or null once a later second request replaced it.
 *
 * A correction is about the request it was made on. When the Case Manager later
 * reads a `new_issue`, that request is matched on its own, and the correction
 * stays in the audit trail only.
 *
 * @param newIssueAt when the latest `new_issue` reading was written, or null
 */
export function activeSituationOverride(overrides, { newIssueAt = null } = {}) {
  const entry = overrides?.situation;
  if (!entry?.value) return null;
  const setAt = Date.parse(entry.set_at ?? '');
  const newIssue = Date.parse(newIssueAt ?? '');
  if (!Number.isNaN(newIssue) && (Number.isNaN(setAt) || newIssue > setAt)) return null;
  return entry;
}

/**
 * The categoriser's columns, with a person's values kept.
 *
 * The model's reading of an overridden field goes to `overrides.<field>.ai_value`
 * instead of the column, so « Reset to automatic » returns to what the model
 * says NOW, not to what it said before the correction.
 *
 * @returns {{ columns, overrides }} `overrides` is null when nothing is overridden
 */
export function keepOverrides(ticket, columns) {
  const current = overridesOf(ticket);
  const touched = CATEGORISER_FIELDS.filter((field) => current[field] && Object.hasOwn(columns, field));
  if (touched.length === 0) return { columns, overrides: null };
  const next = { ...current };
  const kept = { ...columns };
  for (const field of touched) {
    next[field] = { ...current[field], ai_value: columns[field] };
    kept[field] = current[field].value;
  }
  return { columns: kept, overrides: next };
}

/**
 * What one Save writes.
 *
 * @param ticket  the row as read: `status, investigated_at, overrides` and the override columns
 * @param changes `{ field: value }` to set, `{ field: null }` to reset to automatic
 * @param aiSituation the situation the pipeline settled on, kept as `ai_value`
 * @param isInvestigable the investigation's own scope rule (`investigation-rules.mjs`),
 *        injected so this module does not reach into the agent. Asked of the
 *        ticket AS IT WILL BE: a subject that is forwarded (kind `contact`),
 *        b2b, level 4 or not enabled is never queued — the run would only skip it.
 * @returns `{ columns, audit, requeued, notInvestigable, versionChanged }` — `audit` is the rows for `ticket_overrides`
 */
export function overrideChange({
  ticket,
  changes,
  actorId = null,
  source = 'edit_case',
  aiSituation = null,
  isInvestigable = () => true,
  at = new Date().toISOString()
}) {
  const current = overridesOf(ticket);
  const next = { ...current };
  const columns = {};
  const audit = [];
  const changed = [];

  for (const [field, raw] of Object.entries(changes ?? {})) {
    if (!OVERRIDE_FIELDS.includes(field)) throw new Error(`${field} cannot be overridden.`);
    const existing = current[field] ?? null;

    if (raw === null) {
      // RESET: the column returns to the model's value; a held status is released.
      if (!existing) continue;
      delete next[field];
      if (COLUMN_FIELDS.includes(field) && field !== 'status') columns[field] = existing.ai_value ?? null;
      audit.push({ field, action: 'cleared', value: null, ai_value: stringOrNull(existing.ai_value), set_by: actorId, source, set_at: at });
      changed.push(field);
      continue;
    }

    const value = validOverrideValue(field, raw);
    if (value === null) throw new Error(`${String(raw)} is not a valid ${field}.`);
    const aiValue = existing ? existing.ai_value ?? null : field === 'situation' ? aiSituation : field === 'priority' ? null : ticket?.[field] ?? null;
    if (existing && existing.value === value) continue;
    // A value equal to what the pipeline says is not an override: it is a reset.
    if (!existing && field !== 'status' && aiValue !== null && aiValue === value) continue;

    next[field] = { value, ai_value: aiValue, set_by: actorId, set_at: at, source };
    if (COLUMN_FIELDS.includes(field)) columns[field] = value;
    audit.push({ field, action: 'set', value: String(value), ai_value: stringOrNull(aiValue), set_by: actorId, source, set_at: at });
    changed.push(field);
  }

  if (changed.length === 0) return { columns: {}, audit: [], requeued: false, notInvestigable: false, versionChanged: false, changed };
  columns.overrides = next;

  // ONE SAVE, ONE RUN. A meaning change queues the investigation once, however
  // many fields moved. A category change alone is only a label while a person
  // has pinned the situation: the matcher, which the category filters, is not
  // asked.
  const situationPinned = Boolean(next.situation?.value);
  const wantsRun = changed.some((field) => field === 'situation' || (field === 'category' && !situationPinned));
  // OUT OF SCOPE AFTER THE CHANGE: no run. The version still moves, so the draft
  // written for the old subject is staled and can never be sent.
  const notInvestigable = wantsRun && !isInvestigable({ ...ticket, ...columns });
  const needsRun = wantsRun && !notInvestigable;
  const requeue = needsRun ? reinvestigationColumns({ ...ticket, ...columns }, { evenIfNeverInvestigated: true }) : {};
  // A person's status in the same Save wins over the reopen.
  if (requeue.status && Object.hasOwn(columns, 'status')) delete requeue.status;
  Object.assign(columns, requeue);

  return {
    columns,
    audit,
    requeued: Boolean(requeue.needs_investigation),
    notInvestigable,
    versionChanged: changed.some((field) => VERSION_FIELDS.includes(field)),
    changed
  };
}

function stringOrNull(value) {
  return value === null || value === undefined ? null : String(value);
}

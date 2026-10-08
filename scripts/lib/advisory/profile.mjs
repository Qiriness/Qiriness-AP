/**
 * The advisory profile: what the conversation has established about the
 * customer, field by field, each with where it came from and how sure it is.
 *
 *   { skin_type: { value: 'dry', source: 'natural_language', confidence: 'medium', turn: 3 }, … }
 *
 * CHANNEL-FREE. A storefront chip, a sentence and (later) an email thread all
 * arrive as `updates` and merge by the same rules. Which values are allowed is
 * the shop's config (its concerns, its slot kinds), so another brand's
 * vocabulary needs no code.
 */

export const FIELDS = {
  body_area: { multi: false },
  skin_type: { multi: false },
  skin_behaviour: { multi: true },
  sensitivity: { multi: false },
  primary_concern: { multi: false },
  secondary_concerns: { multi: true },
  current_routine: { multi: true },
  desired_care_type: { multi: false },
  routine_scope: { multi: false },
  sex_target: { multi: false },
  age_band: { multi: false },
  preferences: { multi: true },
  known_exclusions: { multi: true }
};

export const SOURCES = ['quick_choice', 'natural_language', 'model_inferred', 'page_context', 'inferred'];
/** A quick choice or an explicit sentence outranks an inference; equals replace (the customer corrected themselves). */
const SOURCE_RANK = { quick_choice: 3, natural_language: 3, model_inferred: 2, page_context: 1, inferred: 0 };
export const CONFIDENCE = ['high', 'medium', 'low'];

const FIXED_VALUES = {
  body_area: ['face', 'eyes', 'body', 'lips', 'hands'],
  skin_type: ['very_dry', 'dry', 'normal', 'combination', 'oily', 'unknown'],
  skin_behaviour: ['tightness', 'shine', 'dehydration', 'dullness', 'reactive', 'flaking'],
  sensitivity: ['none', 'sensitive', 'reactive', 'unknown'],
  routine_scope: ['targeted', 'essential', 'complete', 'complete_existing', 'unknown'],
  sex_target: ['men', 'women'],
  age_band: ['under_30', '30_44', '45_59', '60_plus', 'unknown']
};
const FREE_TEXT = /^[\p{L}\p{N} '’-]{2,40}$/u;

/**
 * The allowed values per field, for one shop's config: fixed lists plus the
 * config's concerns and slot kinds.
 * @param {{ concernKeys: string[], slotKinds: string[] }} vocabulary
 */
export function allowedValues(vocabulary) {
  const concerns = [...vocabulary.concernKeys, 'unknown'];
  return {
    ...FIXED_VALUES,
    primary_concern: concerns,
    secondary_concerns: vocabulary.concernKeys,
    current_routine: [...vocabulary.slotKinds, 'none'],
    desired_care_type: vocabulary.slotKinds
  };
}

export function isValidUpdate(update, allowed) {
  if (!update || !FIELDS[update.field]) return false;
  if (update.field === 'preferences' || update.field === 'known_exclusions') return typeof update.value === 'string' && FREE_TEXT.test(update.value);
  return (allowed[update.field] ?? []).includes(update.value);
}

/** The value of a field, or null (`unknown` counts as answered, not as a value). */
export function valueOf(profile, field) {
  const v = profile?.[field]?.value;
  if (v === undefined || v === null || v === 'unknown') return null;
  return Array.isArray(v) && !v.length ? null : v;
}

/** Answered, even with « je ne sais pas »: never asked again. */
export function isAnswered(profile, field) {
  const v = profile?.[field]?.value;
  return v !== undefined && v !== null && !(Array.isArray(v) && !v.length);
}

/**
 * Merge updates into a profile. Returns the new profile and the fields that
 * changed (for `profile_field_collected` events). Invalid updates are dropped.
 *
 * - A new primary concern demotes the previous one to secondary.
 * - A natural-language concern arriving after the primary is set is secondary,
 *   unless it is a quick choice for primary_concern (an answer to « what
 *   bothers you most? »).
 * - current_routine `none` replaces the list; a real step removes `none`.
 */
export function mergeProfile(profile, updates, { allowed, turn = 0 } = {}) {
  const next = structuredClone(profile ?? {});
  const changed = [];
  const set = (field, value, u) => {
    const before = JSON.stringify(next[field]?.value ?? null);
    next[field] = { value, source: u.source, confidence: u.confidence ?? 'medium', turn };
    if (JSON.stringify(value) !== before) changed.push({ field, source: u.source });
  };
  const outranks = (field, u) => (SOURCE_RANK[u.source] ?? 0) >= (SOURCE_RANK[next[field]?.source] ?? -1);

  for (const u of updates ?? []) {
    if (!SOURCES.includes(u?.source) || !isValidUpdate(u, allowed)) continue;
    const { field, value } = u;
    if (field === 'primary_concern') {
      const current = next.primary_concern?.value;
      if (current && current !== 'unknown' && current !== value) {
        const explicitAnswer = u.source === 'quick_choice' || u.replace === true;
        if (!explicitAnswer) {
          addTo('secondary_concerns', value, u);
          continue;
        }
        addTo('secondary_concerns', current, u);
      }
      if (!next.primary_concern || outranks(field, u) || next.primary_concern.value === 'unknown') {
        set(field, value, u);
        removeFrom('secondary_concerns', value);
      }
      continue;
    }
    if (field === 'secondary_concerns') {
      if (value !== next.primary_concern?.value) addTo(field, value, u);
      continue;
    }
    if (FIELDS[field].multi) {
      if (field === 'current_routine' && value === 'none') set(field, ['none'], u);
      else addTo(field, value, u);
      continue;
    }
    if (!next[field] || outranks(field, u)) set(field, value, u);
  }
  return { profile: next, changed };

  function addTo(field, value, u) {
    const list = (next[field]?.value ?? []).filter((v) => !(field === 'current_routine' && v === 'none'));
    if (list.includes(value)) return;
    set(field, [...list, value], u);
  }
  function removeFrom(field, value) {
    if (!next[field]) return;
    next[field] = { ...next[field], value: next[field].value.filter((v) => v !== value) };
  }
}

/** The profile as plain field → value, for prompts and traces. */
export function profileSummary(profile) {
  return Object.fromEntries(Object.entries(profile ?? {}).filter(([, f]) => isAnsweredValue(f?.value)).map(([k, f]) => [k, f.value]));
}
const isAnsweredValue = (v) => v !== undefined && v !== null && !(Array.isArray(v) && !v.length);

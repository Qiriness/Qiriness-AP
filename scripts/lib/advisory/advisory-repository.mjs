/**
 * The advisory config in the database (migration 80) — and back.
 *
 *   advisor_playbooks      one row per playbook, its definition as authored
 *   advisor_mappings       one row per mapping entry: kind (families, slots,
 *                          concerns, …) + key; `_` for single-object sections
 *   advisor_merchandising  one row per priority entry, with its dates
 *
 * The authored file (data/advisor/<brand>.json) is loaded into these tables by
 * `npm run advisor:load`, and the advisor reads them back into the same shape,
 * so the engine never knows which it was given. `configToRows` and
 * `rowsToConfig` round-trip exactly (advisory-repository.test.mjs).
 */

export const ADVISOR_T = {
  PLAYBOOKS: 'advisor_playbooks',
  MAPPINGS: 'advisor_mappings',
  MERCHANDISING: 'advisor_merchandising',
  EVENTS: 'advisory_events'
};

/** Sections stored entry by entry. */
export const MAP_SECTIONS = ['families', 'slots', 'slot_overrides', 'areas', 'targets', 'skin_types', 'skin_type_groups', 'textures', 'concerns', 'labels'];
/** Sections stored whole, under key `_`. */
export const SINGLE_SECTIONS = ['bundles', 'sensitivity', 'maturity', 'merchandising_settings', 'document'];
/** Every other top-level key (version, principles, notes…) travels whole in `document`. */
const SECTION_KEYS = new Set(['playbooks', 'merchandising', ...MAP_SECTIONS, 'bundles', 'sensitivity', 'maturity']);

export function configToRows(raw, shopId) {
  const playbooks = raw.playbooks.map((definition, position) => ({
    shop_id: shopId,
    key: definition.key,
    position,
    status: 'active',
    version: raw.version ?? 1,
    definition
  }));
  const mappings = [];
  for (const kind of MAP_SECTIONS) {
    Object.entries(raw[kind] ?? {}).forEach(([key, definition], position) => mappings.push({ shop_id: shopId, kind, key, position, definition }));
  }
  for (const kind of ['bundles', 'sensitivity', 'maturity']) {
    if (raw[kind] !== undefined) mappings.push({ shop_id: shopId, kind, key: '_', position: 0, definition: raw[kind] });
  }
  const { entries = [], ...settings } = raw.merchandising ?? {};
  mappings.push({ shop_id: shopId, kind: 'merchandising_settings', key: '_', position: 0, definition: settings });
  mappings.push({ shop_id: shopId, kind: 'document', key: '_', position: 0, definition: Object.fromEntries(Object.entries(raw).filter(([k]) => !SECTION_KEYS.has(k))) });
  const merchandising = entries.map((e) => ({
    shop_id: shopId,
    target_kind: e.target_kind,
    target: e.target,
    tier: e.tier,
    concern: e.concern ?? null,
    slot: e.slot ?? null,
    starts_at: e.starts_at ?? null,
    ends_at: e.ends_at ?? null,
    note: e.note ?? null
  }));
  return { playbooks, mappings, merchandising };
}

/** Rows → the authored shape. Null when the shop has no active playbook. */
export function rowsToConfig({ playbooks = [], mappings = [], merchandising = [] }) {
  const active = playbooks.filter((r) => r.status === 'active').sort((a, b) => a.position - b.position);
  if (!active.length) return null;
  const byKind = (kind) => mappings.filter((m) => m.kind === kind).sort((a, b) => a.position - b.position);
  const single = (kind) => byKind(kind)[0]?.definition;
  const raw = { ...(single('document') ?? {}), playbooks: active.map((r) => r.definition) };
  for (const kind of MAP_SECTIONS) raw[kind] = Object.fromEntries(byKind(kind).map((m) => [m.key, m.definition]));
  for (const kind of ['bundles', 'sensitivity', 'maturity']) if (single(kind) !== undefined) raw[kind] = single(kind);
  raw.merchandising = {
    ...(single('merchandising_settings') ?? {}),
    entries: merchandising.map((m) => Object.fromEntries(Object.entries({
      target_kind: m.target_kind, target: m.target, tier: m.tier, concern: m.concern, slot: m.slot, starts_at: m.starts_at, ends_at: m.ends_at, note: m.note
    }).filter(([, v]) => v !== null && v !== undefined)))
  };
  return raw;
}

/**
 * @param {{ selectAll: (table: string, filters: object, columns: string) => Promise<object[]> }} db
 * @returns {Promise<object | null>} the raw config, or null when none is loaded for this shop
 */
export async function loadAdvisoryConfig(db, shopId) {
  const [playbooks, mappings, merchandising] = await Promise.all([
    db.selectAll(ADVISOR_T.PLAYBOOKS, { shop_id: shopId }, 'key,position,status,definition'),
    db.selectAll(ADVISOR_T.MAPPINGS, { shop_id: shopId }, 'kind,key,position,definition'),
    db.selectAll(ADVISOR_T.MERCHANDISING, { shop_id: shopId }, 'target_kind,target,tier,concern,slot,starts_at,ends_at,note')
  ]);
  return rowsToConfig({ playbooks, mappings, merchandising });
}

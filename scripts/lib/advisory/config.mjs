/**
 * The shop's advisory config — playbooks, the mappings that make them
 * executable, merchandising — validated, compiled, and checked against a
 * catalogue.
 *
 * NO PRODUCT IS NAMED BY ID, ANYWHERE. A playbook names a family (« Temps
 * Sublime ») and slots (serum, moisturiser); `families`, `slots` and the signal
 * sections map those onto collection handles, tags, care types (the title's
 * head noun) and name words. `checkCatalogue` reports every reference that
 * resolves to nothing, so a renamed collection is a warning at load, never a
 * silent empty routine.
 *
 * PRODUCT FACTS ARE NOT HERE. The config says which product fills which step
 * for whom; what the product does comes from product data only.
 */

import { careTypeOf, hasPhrase, norm } from './text.mjs';

const SCOPES = ['targeted', 'essential', 'complete'];

/** Structural problems that make the config unusable. Empty means valid. */
export function validateConfig(raw) {
  const errors = [];
  const need = (cond, message) => { if (!cond) errors.push(message); };
  need(raw && typeof raw === 'object', 'config is not an object');
  if (!raw || typeof raw !== 'object') return errors;
  need(Array.isArray(raw.playbooks) && raw.playbooks.length > 0, 'playbooks: none');
  for (const section of ['families', 'slots', 'areas', 'concerns', 'textures', 'skin_type_groups']) {
    need(raw[section] && typeof raw[section] === 'object', `${section}: missing`);
  }
  if (errors.length) return errors;

  const keys = new Set();
  for (const p of raw.playbooks) {
    const where = `playbook ${p?.key ?? '?'}`;
    need(typeof p?.key === 'string' && /^[a-z0-9_]+$/.test(p.key), `${where}: key`);
    need(!keys.has(p.key), `${where}: duplicate key`);
    keys.add(p.key);
    need(Boolean(raw.areas[p.area]), `${where}: unknown area ${p.area}`);
    if (p.target) need(Boolean(raw.targets?.[p.target]), `${where}: unknown target ${p.target}`);
    if (p.preferred_family) need(Boolean(raw.families[p.preferred_family]), `${where}: unknown family ${p.preferred_family}`);
    const routes = p.routes ?? [];
    need(routes.length > 0 || (p.primary_concerns ?? []).length > 0, `${where}: no concerns`);
    for (const concern of [...(p.primary_concerns ?? []), ...routes.flatMap((r) => r.concerns ?? [])]) {
      need(Boolean(raw.concerns[concern]), `${where}: concern ${concern} has no signals`);
    }
    const own = [...(p.primary_concerns ?? []), ...routes.flatMap((r) => r.concerns ?? [])];
    for (const c of p.distinguish_by ?? []) need(own.includes(c), `${where}: distinguish_by ${c} is not one of its concerns`);
    for (const slot of slotsNamed(p)) need(Boolean(raw.slots[slot]), `${where}: unknown slot ${slot}`);
    for (const rules of [p.texture, ...routes.map((r) => r.texture)].filter(Boolean)) {
      for (const [slot, list] of Object.entries(rules)) {
        need(Array.isArray(list), `${where}: texture ${slot}`);
        for (const [group, texture] of list ?? []) {
          need(Boolean(raw.skin_type_groups[group]), `${where}: unknown skin type group ${group}`);
          need(Boolean(raw.textures[texture]), `${where}: unknown texture ${texture}`);
        }
      }
    }
  }
  for (const [key, slot] of Object.entries(raw.slots)) need(typeof slot?.kind === 'string', `slot ${key}: kind`);
  const tiers = raw.merchandising?.tiers ?? {};
  for (const [tier, boost] of Object.entries(tiers)) need(typeof boost === 'number' && boost >= 0 && boost <= 0.2, `merchandising tier ${tier}: boost must be 0–0.2`);
  for (const e of raw.merchandising?.entries ?? []) {
    need(e?.tier in tiers, `merchandising entry ${e?.target}: unknown tier ${e?.tier}`);
    need(['product', 'collection', 'family'].includes(e?.target_kind), `merchandising entry ${e?.target}: target_kind`);
  }
  return errors;
}

function slotsNamed(p) {
  const fromScopes = SCOPES.flatMap((s) => [...(p[s]?.slots ?? []), ...(p[s]?.priority_slots ?? [])]);
  const fromRoutes = (p.routes ?? []).flatMap((r) => [...(r.slots ?? []), ...(r.targeted ?? []), ...(r.essential ?? []), ...(r.optional ?? [])]);
  return [...new Set([...fromScopes, ...fromRoutes])];
}

/** Every concern any playbook or route answers, in playbook order. */
export function concernKeys(raw) {
  return [...new Set(raw.playbooks.flatMap((p) => [...(p.primary_concerns ?? []), ...(p.routes ?? []).flatMap((r) => r.concerns ?? [])]))];
}

export function compileConfig(raw) {
  const errors = validateConfig(raw);
  if (errors.length) throw new Error(`advisory config invalid: ${errors.join('; ')}`);
  const slotKinds = [...new Set(Object.values(raw.slots).map((s) => s.kind))];
  return {
    raw,
    playbooks: raw.playbooks,
    vocabulary: { concernKeys: concernKeys(raw), slotKinds },
    merchandising: {
      tiers: raw.merchandising?.tiers ?? {},
      window: raw.merchandising?.tie_window ?? 0.15,
      entries: raw.merchandising?.entries ?? []
    }
  };
}

/**
 * Per product, every signal the engine reads, computed once per catalogue.
 * @param {{ id: string, handle: string, name: string, tags: string[], collections: string[], inStock: boolean, keyIngredients?: string | null, description?: string | null }} product
 */
export function productSignals(product, raw) {
  const name = norm(product.name);
  const tags = new Set((product.tags ?? []).map(norm));
  const collections = new Set(product.collections ?? []);
  const hasTag = (list) => (list ?? []).some((t) => tags.has(norm(t)));
  const inCollection = (list) => (list ?? []).some((c) => collections.has(c));
  const hasWord = (list) => (list ?? []).some((w) => hasPhrase(name, w));
  const matches = (spec) => Boolean(spec) && (hasTag(spec.tags) || inCollection(spec.collections) || hasWord(spec.name_words));

  // Areas: an exclusive area (eyes, lips, hands) claims the product alone.
  const areas = new Set();
  for (const [area, spec] of Object.entries(raw.areas)) {
    if (!spec.exclusive || !matches(spec)) continue;
    if (spec.not_if_area && areas.has(spec.not_if_area)) continue;
    areas.add(area);
    break;
  }
  if (!areas.size) for (const [area, spec] of Object.entries(raw.areas)) if (!spec.exclusive && matches(spec)) areas.add(area);

  const skinTypes = new Set(Object.entries(raw.skin_types ?? {}).filter(([k, spec]) => k !== '_all' && hasTag(spec.tags)).map(([k]) => k));
  const textures = new Set(Object.entries(raw.textures).filter(([, spec]) => !spec.unmarked && (hasWord(spec.name_words) || hasTag(spec.tags))).map(([k]) => k));
  // A name word outranks a tag: « … Light » is light even if tagged « crème riche ».
  const byName = Object.entries(raw.textures).filter(([, spec]) => !spec.unmarked && hasWord(spec.name_words)).map(([k]) => k);
  const careType = careTypeOf(product.name);
  return {
    product,
    id: product.id,
    handle: product.handle,
    name,
    tags,
    collections,
    careType,
    areas,
    men: Object.values(raw.targets ?? {}).length ? hasTag(raw.targets.men?.tags) : false,
    bundle: (raw.bundles?.care_types ?? []).includes(careType) || hasWord(raw.bundles?.name_words),
    inStock: product.inStock === true,
    skinTypes,
    allSkin: hasTag(raw.skin_types?._all?.tags),
    textures: byName.length ? new Set(byName) : textures,
    sensitiveCollection: inCollection(raw.sensitivity?.collections),
    sensitiveTag: hasTag(raw.sensitivity?.tags),
    mature: hasTag(raw.maturity?.tags),
    // What a customer exclusion (« sans parfum », « pas de rétinol ») is checked
    // against: name and key ingredients. Not the description, which says « sans
    // parfum » on the very products that have none.
    text: norm([product.name, product.keyIngredients].filter(Boolean).join(' '))
  };
}

/** Does a product belong in a slot? Every specified group must match (OR within a group). */
export function inSlot(sig, spec) {
  if (!spec) return false;
  if (spec.collections?.length && !spec.collections.some((c) => sig.collections.has(c))) return false;
  if (spec.care_types?.length && !spec.care_types.includes(sig.careType)) return false;
  if (spec.name_words?.length && !spec.name_words.some((w) => hasPhrase(sig.name, w))) return false;
  if (spec.tags?.length && !spec.tags.some((t) => sig.tags.has(norm(t)))) return false;
  if ((spec.exclude_name_words ?? []).some((w) => hasPhrase(sig.name, w))) return false;
  return true;
}

export function inFamily(sig, spec) {
  if (!spec) return false;
  if (spec.collections?.length && !spec.collections.some((c) => sig.collections.has(c))) return false;
  if (spec.name_words?.length && !spec.name_words.some((w) => hasPhrase(sig.name, w))) return false;
  return true;
}

/**
 * Every mapping reference that matches nothing in this catalogue. Warnings,
 * not errors: a sold-out or renamed range must surface, not crash the advisor.
 */
export function checkCatalogue(raw, catalogue) {
  const sigs = catalogue.products.map((p) => productSignals(p, raw));
  const collectionHandles = new Set(catalogue.collections.map((c) => c.handle));
  const allTags = new Set(catalogue.products.flatMap((p) => (p.tags ?? []).map(norm)));
  const problems = [];
  const checkCollections = (list, where) => { for (const c of list ?? []) if (!collectionHandles.has(c)) problems.push(`${where}: collection ${c} is not an active collection`); };
  const checkTags = (list, where) => { for (const t of list ?? []) if (!allTags.has(norm(t))) problems.push(`${where}: tag « ${t} » is on no product`); };

  for (const [name, spec] of Object.entries(raw.families)) {
    checkCollections(spec.collections, `family ${name}`);
    if (!sigs.some((s) => inFamily(s, spec))) problems.push(`family ${name}: matches no product`);
  }
  for (const [key, spec] of Object.entries(raw.slots)) {
    checkCollections(spec.collections, `slot ${key}`);
    if (!sigs.some((s) => inSlot(s, spec))) problems.push(`slot ${key}: matches no product`);
  }
  for (const [target, slots] of Object.entries(raw.slot_overrides ?? {})) {
    for (const [key, spec] of Object.entries(slots)) {
      if (!sigs.some((s) => inSlot(s, spec) && s.men === (target === 'men'))) problems.push(`slot ${key} (${target}): matches no product`);
    }
  }
  for (const [key, spec] of Object.entries(raw.concerns)) {
    checkCollections(spec.collections, `concern ${key}`);
    checkTags(spec.tags, `concern ${key}`);
  }
  for (const [key, spec] of Object.entries(raw.areas)) {
    checkCollections(spec.collections, `area ${key}`);
    checkTags(spec.tags, `area ${key}`);
  }
  for (const e of raw.merchandising?.entries ?? []) {
    if (e.target_kind === 'product' && !catalogue.products.some((p) => p.handle === e.target)) problems.push(`merchandising: product ${e.target} is not live`);
    if (e.target_kind === 'collection' && !collectionHandles.has(e.target)) problems.push(`merchandising: collection ${e.target} is not active`);
    if (e.target_kind === 'family' && !raw.families[e.target]) problems.push(`merchandising: family ${e.target} is unknown`);
  }
  return { problems, signals: sigs };
}

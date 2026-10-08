/**
 * One routine step, filled: hard eligibility, then customer suitability, then
 * routine fit, then — last, bounded — merchandising.
 *
 *   eligible?      stock, area, target, bundle, the customer's exclusions   HARD (rules 2, 3, 4, 5)
 *   suitability    primary concern > sensitivity > secondary concerns;
 *                  skin type → texture for cream steps (rule 8); age ≤ 0.05 (rule 6)
 *   routine fit    the playbook's preferred family; the slot's preferred name words
 *   merchandising  a tier boost (≤ 0.2) for products whose suitability is within
 *                  `window` of the best — it reorders good matches and can never
 *                  lift an unsuitable one (rule 10)
 *
 * Each term is returned as reason codes, so a recommendation is explainable
 * and every rule is a test on this function's output.
 */

import { EXCLUSION, FIT } from './reason-codes.mjs';
import { hasPhrase, norm } from './text.mjs';
import { inFamily, inSlot } from './config.mjs';
import { valueOf } from './profile.mjs';

export const WEIGHTS = {
  primaryCollection: 1,
  primaryTag: 0.5,
  secondaryCollection: 0.25,
  secondaryTag: 0.15,
  secondaryCap: 0.5,
  skinMatch: 0.1,
  skinMismatch: -0.4,
  sensitiveCollection: 0.3,
  sensitiveTag: 0.1,
  notForSensitive: -0.3,
  textureMatch: 0.3,
  textureMismatch: -0.3,
  standardMatch: 0.2,
  standardMismatch: -0.1,
  ageMax: 0.05,
  family: 0.5,
  slotName: 0.2,
  /** Below this, a product is unsuitable: never recommended, never boosted. */
  floor: -0.25
};

/** Hard eligibility. Returns the exclusion code, or null when eligible. */
export function exclusionOf(sig, { area, men, exclusions = [], wantsBundle = false }) {
  if (!sig.inStock) return EXCLUSION.OUT_OF_STOCK;
  if (!sig.areas.has(area)) return EXCLUSION.WRONG_AREA;
  if (men ? !sig.men : sig.men) return EXCLUSION.WRONG_TARGET;
  if (sig.bundle && !wantsBundle) return EXCLUSION.BUNDLE_NOT_REQUESTED;
  if (exclusions.some((word) => hasPhrase(sig.text, word))) return EXCLUSION.EXCLUDED_BY_CUSTOMER;
  return null;
}

/** The texture this playbook wants for a cream step, given the skin type. */
export function wantedTexture(rules, slotSpec, profile, raw) {
  const list = rules?.[slotSpec.texture_slot];
  if (!list) return null;
  const skin = valueOf(profile, 'skin_type');
  const behaviours = valueOf(profile, 'skin_behaviour') ?? [];
  const primary = valueOf(profile, 'primary_concern');
  // Skin type first (rule 8: it mainly chooses the texture); a behaviour such
  // as dehydration only when the skin type says nothing.
  for (const [group, texture] of list) {
    const g = raw.skin_type_groups[group];
    if (g.any || (skin && (g.skin_types ?? []).includes(skin))) return texture;
  }
  for (const [group, texture] of list) {
    if ((raw.skin_type_groups[group].behaviours ?? []).some((b) => behaviours.includes(b) || b === primary)) return texture;
  }
  return null;
}

/** Customer fit of one product, with its reasons. Never includes routine fit or merchandising. */
export function suitability(sig, { profile, raw, texture }) {
  const reasons = [];
  let score = 0;
  const primary = valueOf(profile, 'primary_concern');
  const concernHit = (key) => {
    const spec = raw.concerns[key];
    if (!spec) return null;
    if ((spec.collections ?? []).some((c) => sig.collections.has(c))) return 'collection';
    if ((spec.tags ?? []).some((t) => sig.tags.has(norm(t)))) return 'tag';
    return null;
  };
  if (primary) {
    const hit = concernHit(primary);
    if (hit) {
      score += hit === 'collection' ? WEIGHTS.primaryCollection : WEIGHTS.primaryTag;
      reasons.push(`${FIT.PRIMARY_CONCERN}:${primary}`);
    }
  }
  let secondary = 0;
  for (const c of valueOf(profile, 'secondary_concerns') ?? []) {
    const hit = concernHit(c);
    if (!hit) continue;
    secondary += hit === 'collection' ? WEIGHTS.secondaryCollection : WEIGHTS.secondaryTag;
    reasons.push(`${FIT.SECONDARY_CONCERN}:${c}`);
  }
  score += Math.min(secondary, WEIGHTS.secondaryCap);

  const skin = valueOf(profile, 'skin_type');
  if (skin) {
    if (sig.skinTypes.has(skin) || sig.allSkin) {
      score += WEIGHTS.skinMatch;
      reasons.push(`${FIT.SKIN_TYPE_MATCH}:${skin}`);
    } else if (sig.skinTypes.size) {
      score += WEIGHTS.skinMismatch;
      reasons.push(`${FIT.SKIN_TYPE_MISMATCH}:${skin}`);
    }
  }

  const sensitivity = valueOf(profile, 'sensitivity');
  if (sensitivity === 'sensitive' || sensitivity === 'reactive') {
    if (sig.sensitiveCollection) { score += WEIGHTS.sensitiveCollection; reasons.push(FIT.SENSITIVE_SKIN_MATCH); }
    else if (sig.sensitiveTag) { score += WEIGHTS.sensitiveTag; reasons.push(FIT.SENSITIVE_SKIN_MATCH); }
    else { score += WEIGHTS.notForSensitive; reasons.push(FIT.NOT_FOR_SENSITIVE); }
  }

  if (texture) {
    const spec = raw.textures[texture];
    if (spec.unmarked) {
      if (!sig.textures.size) { score += WEIGHTS.standardMatch; reasons.push(`${FIT.TEXTURE_MATCH}:${texture}`); }
      else { score += WEIGHTS.standardMismatch; reasons.push(`${FIT.TEXTURE_MISMATCH}:${[...sig.textures][0]}`); }
    } else if (sig.textures.has(texture)) {
      score += WEIGHTS.textureMatch;
      reasons.push(`${FIT.TEXTURE_MATCH}:${texture}`);
    } else if (spec.opposite && sig.textures.has(spec.opposite)) {
      score += WEIGHTS.textureMismatch;
      reasons.push(`${FIT.TEXTURE_MISMATCH}:${spec.opposite}`);
    }
  }

  // Age: a tie-breaker, never more (rule 6, rule 7).
  const age = valueOf(profile, 'age_band');
  if (age && (age === '45_59' || age === '60_plus') && sig.mature) {
    score += WEIGHTS.ageMax;
    reasons.push(FIT.AGE_TIEBREAK);
  }
  return { score: round(score), reasons };
}

/** The merchandising tier that applies to this product for this step, or null. */
export function merchandisingTier(sig, { merchandising, raw, slotKey, primary, now }) {
  let best = null;
  for (const e of merchandising.entries) {
    if (e.starts_at && new Date(e.starts_at) > now) continue;
    if (e.ends_at && new Date(e.ends_at) < now) continue;
    if (e.slot && e.slot !== slotKey) continue;
    if (e.concern && e.concern !== primary) continue;
    const hit = e.target_kind === 'product' ? sig.handle === e.target
      : e.target_kind === 'collection' ? sig.collections.has(e.target)
      : e.target_kind === 'family' ? inFamily(sig, raw.families[e.target]) : false;
    if (!hit) continue;
    const boost = merchandising.tiers[e.tier] ?? 0;
    if (!best || boost > best.boost) best = { tier: e.tier, boost };
  }
  return best;
}

/**
 * Rank the candidates for one step.
 * @returns {{ ranked: object[], excluded: Record<string, number>, preferredUnavailable: boolean }}
 */
export function rankSlot({ slotKey, spec, signals, profile, raw, merchandising, family, texture, eligibility, used = new Set(), toleranceFirst = false, now = new Date() }) {
  const excluded = {};
  const inThisSlot = signals.filter((s) => inSlot(s, spec) && !used.has(s.id));
  const pool = [];
  for (const sig of inThisSlot) {
    const code = exclusionOf(sig, eligibility);
    if (code) { excluded[code] = (excluded[code] ?? 0) + 1; continue; }
    const fit = suitability(sig, { profile, raw, texture });
    // A treatment step must address the need: a product with no concern of the
    // customer's, outside the preferred line, is not « the best available ».
    const addressesNeed = fit.reasons.some((r) => r.startsWith(FIT.PRIMARY_CONCERN) || r.startsWith(FIT.SECONDARY_CONCERN))
      || (family && inFamily(sig, raw.families[family]));
    if (fit.score < WEIGHTS.floor || (spec.concern_required && !addressesNeed)) { excluded[EXCLUSION.UNSUITABLE] = (excluded[EXCLUSION.UNSUITABLE] ?? 0) + 1; continue; }
    pool.push({ sig, fit });
  }
  const familySpec = family ? raw.families[family] : null;
  const preferredUnavailable = Boolean(familySpec)
    && inThisSlot.some((s) => inFamily(s, familySpec) && !s.inStock && s.areas.has(eligibility.area))
    && !pool.some(({ sig }) => inFamily(sig, familySpec));

  const bestFit = pool.length ? Math.max(...pool.map((x) => x.fit.score)) : 0;
  const primary = valueOf(profile, 'primary_concern');
  const ranked = pool.map(({ sig, fit }) => {
    const reasons = [...fit.reasons];
    let routineFit = 0;
    if (familySpec && inFamily(sig, familySpec)) { routineFit += WEIGHTS.family; reasons.push(`${FIT.PREFERRED_FAMILY}:${family}`); }
    if ((spec.prefer_name_words ?? []).some((w) => hasPhrase(sig.name, w))) { routineFit += WEIGHTS.slotName; reasons.push(FIT.SLOT_NAME_MATCH); }
    // Merchandising: suitable AND within the window of the best fit, or nothing.
    // A tolerance-first playbook boosts only products made for sensitive skin.
    let merch = null;
    const withinWindow = fit.score >= bestFit - merchandising.window;
    if (withinWindow && (!toleranceFirst || sig.sensitiveCollection || sig.sensitiveTag)) {
      merch = merchandisingTier(sig, { merchandising, raw, slotKey, primary, now });
      if (merch?.boost) reasons.push(`${FIT.MERCHANDISED}:${merch.tier}`);
      else merch = null;
    }
    return { id: sig.id, handle: sig.handle, sig, suitability: fit.score, routineFit, merch, total: round(fit.score + routineFit + (merch?.boost ?? 0)), reasons };
  });
  ranked.sort((a, b) => b.total - a.total || b.suitability - a.suitability || a.sig.name.localeCompare(b.sig.name));
  return { ranked, excluded, preferredUnavailable };
}

const round = (n) => Math.round(n * 1000) / 1000;

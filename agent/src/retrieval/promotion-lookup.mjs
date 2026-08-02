import { supabaseSelectAll } from '../../../scripts/lib/supabase-rest-client.mjs';

import { evaluateEligibility, findPromotionByCode, normaliseCode } from './promotion-rules.mjs';

// The promotion tool: everything support needs to answer "pourquoi mon code ne
// marche pas ?".
//
// Targets the largest answerable topic left in the corpus — 34 `promotions`
// tickets, 29 of them level 2, and the single biggest cluster in the whole
// inbox is the newsletter welcome code (20 messages).
//
// TWO ENTRY POINTS, because a question mentions a code in two ways: explicitly
// ("le code QIRINESS10 ne fonctionne pas") or not at all ("je n'ai pas reçu ma
// remise de 20%"). The first is a lookup; the second needs the human to supply
// the code, and the tool says so rather than guessing which of three active
// promotions was meant.

const COLUMNS = [
  'id', 'code', 'title', 'method', 'discount_type', 'status',
  'summary', 'short_summary', 'starts_at', 'ends_at',
  'usage_limit', 'discount_usage_count', 'code_usage_count',
  'applies_once_per_customer', 'discount_classes', 'combines_with', 'rule_snapshot'
].join(',');

/** Codes as customers write them: uppercase runs of letters/digits, 4+ long. */
const CODE_PATTERN = /\b[A-Z][A-Z0-9]{3,}\b/g;

export function createPromotionLookup({ supabase, shopId, logger }) {
  let promotionsPromise = null;

  function loadPromotions() {
    if (!promotionsPromise) {
      promotionsPromise = supabaseSelectAll(
        supabase,
        'promotions',
        { shop_id: shopId, deleted_at: { operator: 'is', value: 'null' } },
        COLUMNS
      );
    }
    return promotionsPromise;
  }

  return {
    refresh() {
      promotionsPromise = null;
    },

    /**
     * Pulls candidate discount codes out of a message.
     *
     * Deliberately crude and deliberately verified against the real list: any
     * uppercase token could be a code, so the catch is wide and then filtered
     * to codes that actually exist. Guessing from shape alone would offer
     * "URGENT" or "RE" as discount codes.
     */
    async extractCodes(text) {
      const promotions = await loadPromotions();
      const known = new Set(promotions.map((p) => normaliseCode(p.code)).filter(Boolean));
      const seen = new Set();
      const found = [];

      for (const raw of String(text || '').match(CODE_PATTERN) || []) {
        const code = normaliseCode(raw);
        if (known.has(code) && !seen.has(code)) {
          seen.add(code);
          found.push(code);
        }
      }
      return found;
    },

    /**
     * Full promotion detail plus every eligibility check we can actually make.
     *
     * `customer` is optional. Passing one enables the newsletter check and
     * nothing else today; without it that check reports `unknown` rather than
     * assuming anything.
     */
    async lookupPromotion(code, { customer = null, now = new Date() } = {}) {
      const promotions = await loadPromotions();
      const { promotion, suggestions } = findPromotionByCode(code, promotions);
      const eligibility = evaluateEligibility({ promotion, customer, now });

      logger?.info?.('promotion.lookup', {
        code: normaliseCode(code),
        found: Boolean(promotion),
        verdict: eligibility.verdict,
        blocking: eligibility.blocking.length,
        unknowns: eligibility.unknowns.length
      });

      return {
        found: Boolean(promotion),
        code: normaliseCode(code),
        suggestions: suggestions.map((p) => p.code),
        promotion: promotion ? summarise(promotion) : null,
        eligibility,
        promptText: renderPromotion({ promotion, suggestions, eligibility, code })
      };
    },

    /** Every active promotion — for "quelles promos avez-vous en ce moment ?". */
    async listActive({ now = new Date() } = {}) {
      const promotions = await loadPromotions();
      return promotions
        .filter((p) => {
          if (String(p.status || '').toUpperCase() !== 'ACTIVE') return false;
          if (p.starts_at && now < new Date(p.starts_at)) return false;
          if (p.ends_at && now > new Date(p.ends_at)) return false;
          return true;
        })
        .map(summarise);
    }
  };
}

function summarise(promotion) {
  return {
    code: promotion.code || null,
    title: promotion.title,
    method: promotion.method,
    type: promotion.discount_type,
    status: promotion.status,
    summary: promotion.summary || promotion.short_summary || null,
    startsAt: promotion.starts_at || null,
    endsAt: promotion.ends_at || null,
    usageLimit: promotion.usage_limit ?? null,
    used: promotion.code_usage_count ?? promotion.discount_usage_count ?? null,
    oncePerCustomer: Boolean(promotion.applies_once_per_customer),
    combinesWith: promotion.combines_with || {},
    appliesTo: promotion.discount_classes || []
  };
}

/**
 * Renders for a drafting model.
 *
 * Blocking reasons and unknowns are kept in SEPARATE sections on purpose. Merged
 * into one list a model treats them alike and writes "votre code a expiré et
 * votre panier est insuffisant" when only the first was established. The
 * headings are the guardrail: one section is what we know, the other is what
 * must be asked.
 */
function renderPromotion({ promotion, suggestions, eligibility, code }) {
  if (!promotion) {
    const base = `Le code « ${normaliseCode(code)} » n'existe pas dans la boutique.`;
    return suggestions.length > 0
      ? `${base}\nCodes proches : ${suggestions.map((p) => p.code).join(', ')} — demander confirmation au client.`
      : base;
  }

  const s = summarise(promotion);
  const parts = [`# Code ${s.code || s.title}`];
  if (s.summary) parts.push(s.summary);

  const facts = [
    `Statut : ${s.status}`,
    s.endsAt ? `Expire le : ${s.endsAt.slice(0, 10)}` : "Pas de date d'expiration",
    s.usageLimit === null ? "Pas de limite d'utilisation" : `Utilisations : ${s.used}/${s.usageLimit}`,
    s.oncePerCustomer ? 'Une seule utilisation par client' : 'Utilisable plusieurs fois',
    `S'applique à : ${s.appliesTo.join(', ') || 'non précisé'}`
  ];
  parts.push(`## Détails\n${facts.map((f) => `- ${f}`).join('\n')}`);

  if (eligibility.blocking.length > 0) {
    parts.push(
      `## Cause identifiée\n${eligibility.blocking.map((r) => `- ${r}`).join('\n')}`
    );
  }
  if (eligibility.unknowns.length > 0) {
    parts.push(
      `## À vérifier avec le client (non vérifiable depuis le support)\n` +
        eligibility.unknowns.map((r) => `- ${r}`).join('\n')
    );
  }
  if (eligibility.blocking.length === 0 && eligibility.unknowns.length === 0) {
    parts.push('## Cause identifiée\n- Aucune : le code semble valable.');
  }

  return parts.join('\n\n');
}

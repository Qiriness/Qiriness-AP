import {
  supabaseSelect,
  supabaseUpsert,
  supabaseUpdateById,
  supabaseDeleteWhereIn
} from '../../../scripts/lib/supabase-rest-client.mjs';

import { buildSpamGate, normalizeEmail, normalizeDomain } from './spam-gate.mjs';

// DB-backed access to email_blocklist: build the spam gate from a shop's rules,
// record how often each rule fired, and add a rule (purging any already-stored
// mail from that sender so blocked spam never lingers in storage).

export function createBlocklistStore(supabase) {
  return {
    async loadGate(shopId) {
      const rules = await supabaseSelect(
        supabase,
        'email_blocklist',
        { shop_id: shopId },
        'id,pattern_type,pattern,hit_count'
      );
      const rulesById = new Map(rules.map((rule) => [rule.id, rule]));
      return { gate: buildSpamGate(rules), rulesById };
    },

    // hitCounts: Map<ruleId, count>. Single-worker sequential writes, so a simple
    // read-from-loaded + add is safe without an atomic increment.
    async recordHits(rulesById, hitCounts) {
      if (!hitCounts || hitCounts.size === 0) {
        return;
      }
      const now = new Date().toISOString();
      for (const [ruleId, count] of hitCounts) {
        const base = rulesById.get(ruleId)?.hit_count ?? 0;
        await supabaseUpdateById(supabase, 'email_blocklist', ruleId, {
          hit_count: base + count,
          last_hit_at: now
        });
      }
    },

    async addRule(shopId, { patternType, pattern, reason = null, createdBy = 'system' }) {
      const normalized = patternType === 'domain' ? normalizeDomain(pattern) : normalizeEmail(pattern);
      if (!normalized) {
        throw new Error('Blocklist pattern is empty.');
      }

      const rows = await supabaseUpsert(
        supabase,
        'email_blocklist',
        [{ shop_id: shopId, pattern_type: patternType, pattern: normalized, reason, created_by: createdBy }],
        'shop_id,pattern_type,pattern'
      );

      const purgedTickets = await this.purgeExisting(shopId, patternType, normalized);
      return { rule: rows[0], purgedTickets };
    },

    // Delete any already-stored tickets whose sender matches a (new) rule, using the
    // raw from_email on ticket_messages. Messages cascade with the ticket.
    async purgeExisting(shopId, patternType, normalized) {
      const value = patternType === 'email' ? normalized : `*@${normalized}`;
      const rows = await supabaseSelect(
        supabase,
        'ticket_messages',
        { shop_id: shopId, from_email: { operator: 'ilike', value } },
        'ticket_id'
      );
      const ticketIds = [...new Set(rows.map((row) => row.ticket_id).filter(Boolean))];
      if (ticketIds.length > 0) {
        await supabaseDeleteWhereIn(supabase, 'tickets', 'id', ticketIds);
      }
      return ticketIds.length;
    }
  };
}

import { supabaseSelect, supabaseUpsert } from '../../../scripts/lib/supabase-rest-client.mjs';
import { buildPatternIndex, normalizeDomain, normalizeEmail } from '../../../scripts/lib/sender-patterns.mjs';

// Who is writing to us — reads sender_directory and answers it for one address.
//
// Two consumers, and they want different things from the same table:
//
//   the investigation  wants CONTEXT. The label and note go into the case file
//                      before the model is asked anything, because a sender is
//                      something we always know: spending a tool call to learn
//                      it would be a round trip for a fact already in hand.
//
//   the clustering     wants a FILTER. "What are customers asking?" has to
//     report           exclude our own mail, and until now that list lived in an
//                      env var that did not survive a project move.
//
// See 04_support.sql for why this is a table rather than config.

/**
 * Labels whose mail is not customer demand.
 *
 * `internal` and `contractor` are us. `logistics` and `courier` are operational
 * counterparties — real correspondents, but chasing a pallet is not a question a
 * knowledge article answers.
 *
 * `retailer` / `distributor` / `supplier` / `partner` are deliberately ABSENT.
 * Nocibé sends 10 of the 13 b2b messages in the corpus and every one is a real
 * request; it is simply B2B demand rather than consumer demand. Excluding them
 * would hide a whole class of work, which is the mistake this table exists to
 * stop making in the other direction.
 */
export const NON_DEMAND_LABELS = ['internal', 'contractor', 'logistics', 'courier'];

/**
 * @param rows  sender_directory rows: { pattern_type, pattern, label, note }
 * @param supportMailbox  the support address, whose own domain is internal by
 *   definition. Derived rather than required as a row, so a fresh install is
 *   never wrong about itself and nobody has to remember to add it.
 */
export function buildSenderDirectory(rows = [], { supportMailbox = null } = {}) {
  const own = normalizeDomain(supportMailbox ? supportMailbox.split('@').pop() : null);
  const all = own
    ? [
        // FIRST, so a real row for our own domain overrides it: the index keeps
        // the last write for a given pattern, and a fact somebody typed should
        // beat one this function assumed.
        { pattern_type: 'domain', pattern: own, label: 'internal', note: null, implied: true },
        ...rows
      ]
    : [...rows];

  const index = buildPatternIndex(all);

  return {
    size: index.size,

    /**
     * @returns {{ label, note, pattern, matched } | null} null for an unlisted
     * sender, which is the ordinary case and means "consumer".
     */
    lookup(fromEmail) {
      const hit = index.match(fromEmail);
      if (!hit) {
        return null;
      }
      return {
        label: hit.row.label,
        note: hit.row.note ?? null,
        pattern: hit.row.pattern,
        matched: hit.matched
      };
    },

    /** True when this sender's mail should not be read as customer demand. */
    isNonDemand(fromEmail) {
      const entry = this.lookup(fromEmail);
      return Boolean(entry && NON_DEMAND_LABELS.includes(entry.label));
    }
  };
}

/** A directory that knows nothing — the default before the table is wired. */
export const emptySenderDirectory = buildSenderDirectory([]);

export function createSenderDirectoryStore(supabase) {
  return {
    /**
     * @param {string} shopId
     * @param {{ supportMailbox?: string | null }} [options] — annotated because
     *   `web/` type-checks this file through `allowJs`, and a bare `= null`
     *   default makes TypeScript infer the parameter as `null` and reject the
     *   address every real caller passes.
     */
    async load(shopId, { supportMailbox = null } = {}) {
      const rows = await supabaseSelect(
        supabase,
        'sender_directory',
        { shop_id: shopId },
        'pattern_type,pattern,label,note'
      );
      return buildSenderDirectory(rows, { supportMailbox });
    },

    /**
     * Upsert on the table's own unique constraint, so re-seeding corrects a
     * label rather than failing on a duplicate key.
     */
    async upsert(shopId, entries) {
      const rows = entries
        .map(({ patternType, pattern, label, note = null }) => ({
          shop_id: shopId,
          pattern_type: patternType,
          pattern: patternType === 'domain' ? normalizeDomain(pattern) : normalizeEmail(pattern),
          label,
          note
        }))
        .filter((row) => row.pattern);

      if (rows.length === 0) {
        return [];
      }
      return supabaseUpsert(supabase, 'sender_directory', rows, 'shop_id,pattern_type,pattern');
    }
  };
}

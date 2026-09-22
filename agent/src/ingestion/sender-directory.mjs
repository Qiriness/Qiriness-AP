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
 * Labels that mean the sender is US, stamped onto `tickets.sender_label` when
 * one of them opens a thread.
 *
 * The question is "would a customer-voice reply addressed to this person be
 * absurd" — not "is this customer demand", which is what `NON_DEMAND_LABELS`
 * answers for the clustering report. The two lists overlap and are not the same
 * question, so neither may be used for the other's job.
 *
 * `logistics` IS HERE AND `courier` IS NOT, which looks arbitrary and is not.
 * The 3PL runs our warehouse: their threads are the back office working a
 * customer's return, the same shape as a colleague's, and a reply opening
 * "Bonjour Madame" would be as wrong to them as to a colleague. A courier is a
 * third party we may genuinely need to write to as a customer of theirs.
 *
 * A retailer stays out entirely: Nocibé's purchase orders are real demand, and
 * routing them off the queue would hide a class of work.
 */
export const OWN_SIDE_LABELS = ['internal', 'contractor', 'logistics'];

/**
 * WHO A MESSAGE IS FROM, as a reply-writing model must read it.
 *
 * WHY THIS EXISTS. `tickets.sender_label` is stamped from the address that
 * OPENED a thread and describes the thread. A conversation is not made of one
 * sender: the corpus carries **38 inbound messages from `lap-groupe.com` across
 * 22 tickets** and **14 from Deret across 10**, most of them arriving on threads
 * a customer opened. Rendered as « reçu » beside the customer's own words, a
 * colleague's note and the 3PL's status update read as the customer speaking —
 * and they were read that way: a draft asked the customer for a screenshot on
 * `c5ec7404`, and the closure check reported « le client confirme » about
 * `fcf4ca11`, which is one colleague writing to another.
 *
 * THE FIX IS IN THE DATA, NOT IN FOUR PROMPTS. Three prompts had been told
 * separately that an inbound message is not necessarily the customer, which is a
 * correction the renderer should not need to make in prose. A message that says
 * who sent it needs no such warning.
 *
 * THE ADDRESS NEVER TRAVELS, only what it resolves to — the rule `buildInput`
 * already follows, and the reason `from_email` is absent from the drafting
 * projections. A label is a fact about a company; an address in a prompt is an
 * address a model can quote back to a customer.
 *
 * FALLING BACK TO `customer` IS THE SAFE DIRECTION. An unknown domain is a
 * member of the public until the directory says otherwise, so a sender nobody
 * has classified is read as demand rather than quietly discounted.
 */
export const SENDER_ROLES = {
  qiriness: 'Qiriness',
  customer: 'client',
  internal: 'collègue (LAP Groupe)',
  logistics: 'prestataire logistique',
  courier: 'transporteur',
  contractor: 'prestataire',
  retailer: 'revendeur'
};

// `directory` defaults to null rather than to `emptySenderDirectory`, which is
// declared further down this file. A default parameter is evaluated at call
// time so either works today; a null that the optional chaining below already
// handles cannot stop working if the declarations are ever reordered.
export function senderRole(message, directory = null) {
  if (message?.direction === 'outbound') {
    return 'qiriness';
  }
  const label = directory?.lookup?.(message?.from_email)?.label ?? null;
  return label && SENDER_ROLES[label] ? label : 'customer';
}

/** The role as a reader sees it: « client », « collègue (LAP Groupe) », … */
export function senderRoleName(message, directory = null) {
  return SENDER_ROLES[senderRole(message, directory)];
}

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

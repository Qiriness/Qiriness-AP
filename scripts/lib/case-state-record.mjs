import { supabaseSelect, supabaseUpsert } from './supabase-rest-client.mjs';
import { COLUMNS, T } from './tables.mjs';

/**
 * The `ticket_case_state` row, and the only module that writes it.
 *
 * WHAT IT IS. One reading per inbound message that landed on a ticket already
 * read once: what that message changed about the case. The first message of a
 * thread gets no row — there is nothing for it to change, and the case file
 * already says everything a first reading can.
 *
 * WHY IT LIVES IN `scripts/lib`. The same reason `draft-record.mjs` does:
 * `web/` reaches this directory through `allowJs` and cannot import from
 * `agent/src`, so a store under the worker would force the dashboard to grow a
 * second one over the same columns the day a ticket panel shows what a reply
 * already asked for.
 *
 * WHAT IT OWNS
 *   · the upsert key — one reading per triggering message, never per ticket
 *   · the closed `case_relationship` vocabulary, checked here and in the DDL
 *   · the shop scope, bound once at construction
 *   · the read a pass uses to find the previous reading of a thread
 *
 * WHAT IT DOES NOT OWN
 *   · THE QUEUE. Which tickets are due a reading is derived, not a flag —
 *     see `withoutCaseState`, which follows `withoutDrafts` exactly. A third
 *     `needs_*` column on a populated table is a migration this does not need.
 *   · the situation, the verdict or the ticket's status. Nothing here decides
 *     what happens next; it records what the newest message did, and the
 *     existing rules read it. This is not a second workflow engine.
 *   · what a tool returned. `evidence_reuse` holds outcome buckets and never
 *     tool data, which is the boundary `tool_calls` and `context_ref` already
 *     hold and this module does not reopen.
 */

/**
 * How a new message relates to the case that already existed.
 *
 * A CLOSED VOCABULARY, and the DDL carries the same list — `34_case_state.test.mjs`
 * asserts the two are equal, so a value can only be stored if both agree. The
 * model picks which one; this codebase owns what each means:
 *
 *   continuation     — the same request, moved along. The labels still describe
 *                      the thread, so the categoriser is skipped.
 *   new_information  — the same request, with facts that were not there before.
 *                      Worth re-reading the labels.
 *   new_issue        — a second request inside the same thread. Classification
 *                      is the existing classifier's job, not this layer's.
 *   unclear          — the message could not be placed. Everything runs as it
 *                      did before this layer existed, which is the safe
 *                      direction: the cost is a categorisation call, not a
 *                      customer being answered from the wrong case.
 */
export const CASE_RELATIONSHIPS = ['continuation', 'new_information', 'new_issue', 'unclear'];

/** Relationships that leave the thread's labels describing it correctly. */
export const LABELS_STILL_VALID = ['continuation'];

export function createCaseStateRecord(supabase, { shopId, select = supabaseSelect, upsert = supabaseUpsert } = {}) {
  if (!shopId) {
    throw new Error('createCaseStateRecord requires a shopId.');
  }

  return {
    /**
     * One reading, written against the message that produced it.
     *
     * UPSERT ON (shop_id, trigger_message_id), the key `ticket_investigations`
     * and `ticket_drafts` both use. A re-run rewrites its own row; a reply adds
     * a new one. The trajectory survives as rows rather than being flattened.
     */
    async save(reading) {
      if (!CASE_RELATIONSHIPS.includes(reading?.caseRelationship)) {
        // Refused rather than defaulted. A relationship this module does not
        // recognise is a caller bug, and quietly storing `unclear` would hide
        // it behind behaviour that looks deliberate.
        throw new Error(`Unknown case_relationship: ${reading?.caseRelationship}`);
      }
      const rows = await upsert(
        supabase,
        T.TICKET_CASE_STATE,
        [
          {
            shop_id: shopId,
            ticket_id: reading.ticketId,
            trigger_message_id: reading.triggerMessageId,
            case_relationship: reading.caseRelationship,
            situation_key: reading.situationKey ?? null,
            resolved_inputs: reading.resolvedInputs ?? [],
            pending_customer_inputs: reading.pendingCustomerInputs ?? [],
            new_facts: reading.newFacts ?? [],
            commitments: reading.commitments ?? [],
            contradictions: reading.contradictions ?? [],
            evidence_reuse: reading.evidenceReuse ?? {},
            case_summary: reading.caseSummary ?? null,
            model: reading.model ?? null,
            read_at: reading.readAt ?? new Date().toISOString()
          }
        ],
        'shop_id,trigger_message_id'
      );
      return rows?.[0] ?? null;
    },

    /**
     * The most recent reading of a thread, or null on a thread never read.
     *
     * WHAT THE NEXT READING IS BUILT ON. The situation it carries is what makes
     * a follow-up answerable as the case it belongs to; the pending inputs are
     * what stops a question being asked twice.
     */
    async latest(ticketId, { columns = COLUMNS.caseStateForCasework } = {}) {
      const rows = await select(
        supabase,
        T.TICKET_CASE_STATE,
        { shop_id: shopId, ticket_id: ticketId },
        columns,
        { order: 'read_at.desc', limit: 1 }
      );
      return rows?.[0] ?? null;
    },

    /**
     * The latest reading for each of these tickets, newest first.
     *
     * ONE READ FOR A BATCH, because drafting works a queue rather than a ticket.
     * The caller keeps the first row per ticket; the ordering here is what makes
     * that the newest one.
     */
    async forTickets(ticketIds = []) {
      if (ticketIds.length === 0) return [];
      return select(
        supabase,
        T.TICKET_CASE_STATE,
        { shop_id: shopId, ticket_id: { operator: 'in', value: `(${ticketIds.join(',')})` } },
        COLUMNS.caseStateForCasework,
        { order: 'read_at.desc' }
      );
    },

    /**
     * The trigger message ids among these that ALREADY have a reading.
     *
     * THE QUEUE IS DERIVED, exactly as drafting's is. A ticket leaves the
     * casework queue the moment a reading exists for its newest message, which
     * needs no flag and therefore no column on a populated table. The caller
     * subtracts this set; it is expressed as "which are done" rather than
     * "which are due" because that is the query PostgREST can actually answer.
     */
    async withCaseState(triggerMessageIds = []) {
      if (triggerMessageIds.length === 0) {
        return new Set();
      }
      const rows = await select(
        supabase,
        T.TICKET_CASE_STATE,
        {
          shop_id: shopId,
          trigger_message_id: { operator: 'in', value: `(${triggerMessageIds.join(',')})` }
        },
        'trigger_message_id'
      );
      return new Set(rows.map((row) => row.trigger_message_id));
    }
  };
}

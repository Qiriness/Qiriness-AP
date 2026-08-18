import {
  supabaseSelect,
  supabaseUpdateById,
  supabaseUpsert
} from './supabase-rest-client.mjs';
import { COLUMNS, T } from './tables.mjs';

/**
 * The `ticket_drafts` row, and the only module that writes it.
 *
 * WHY IT EXISTS AND WHY HERE. Two runtimes touch a draft and they touch it from
 * opposite ends: the worker writes what the model produced, the dashboard
 * records what a person decided about it. That is the same split
 * `ticket-record.mjs` was extracted for, and it lives beside it for the same
 * reason — `web/` reaches `scripts/lib` through `allowJs` and cannot import
 * from `agent/src`, so a draft store under the worker would have forced the
 * dashboard to grow a second one over the same columns.
 *
 * WHAT IT OWNS
 *   · the upsert key. One draft per inbound message, never per ticket
 *   · the two bodies, and the rule that `edited` must carry a rewrite
 *   · the human lifecycle (`status`) and the machine outcome (`checks_passed`),
 *     kept apart because they answer different questions
 *   · the review-copy stamp, which is what stops one draft being mailed twice
 *   · the shop scope: bound once, at construction
 *
 * WHAT IT DOES NOT OWN
 *   · THE QUEUE. Which tickets are due a draft is not a column on this table
 *     and deliberately not a flag on `tickets` either — see `withoutDrafts`.
 *   · the case file. `ticket_investigations` is its own contract, in
 *     agent/src/investigation/case-file.mjs; this module stores the id it was
 *     written from and reads nothing out of it.
 *   · what a good draft says. Composition, the prompt and the mechanical
 *     checks are the drafting modules' job; they hand this one columns.
 *
 * NOTHING HERE CAN SEND. There is no recipient parameter on any function
 * below, and the table holds no address. `markReviewSent` stamps that a copy
 * went to the REVIEWER's own inbox; the customer is never addressed from this
 * module or from the row it writes.
 */

/** Statuses a human decision may set. `sent` is absent: no send path exists. */
export const DECISIONS = ['approved', 'edited', 'rejected'];

/**
 * The PostgREST calls this module makes, as one object.
 *
 * Injectable for the same reason ticket-record's is: the tests substitute an
 * in-memory transport and assert the bodies that would have been written, which
 * is the only way to check a rule like "edited must carry a rewrite" without a
 * database.
 */
export const REST_TRANSPORT = {
  select: supabaseSelect,
  updateById: supabaseUpdateById,
  upsert: supabaseUpsert
};

export function createDraftRecord(supabase, { shopId, transport = REST_TRANSPORT }) {
  if (!shopId) {
    throw new Error('createDraftRecord requires a shopId: every read and write here is shop-scoped.');
  }

  const { select, updateById, upsert } = transport;

  return {
    /**
     * Store what the model produced.
     *
     * UPSERT ON (shop_id, trigger_message_id), which is what makes the drafting
     * pass safe to re-run: drafting the same reading twice rewrites one row
     * instead of accumulating near-duplicates a reviewer then has to choose
     * between. A customer's REPLY is a different trigger message, so it lands as
     * a new draft and leaves the one under review alone.
     *
     * IT DOES NOT CARRY THE HUMAN COLUMNS. `status` and `approved_body_text` are
     * absent from the patch rather than reset to their defaults: a re-run is the
     * agent revising its own text, and a re-run that quietly discarded an
     * operator's rewrite — or moved a rejected draft back to pending — would
     * make the review queue unsafe to work through while the worker is running.
     */
    async save({
      ticketId,
      triggerMessageId,
      investigationId,
      sourceVerdict,
      level = null,
      language = null,
      subject = null,
      bodyText,
      checks = [],
      checksPassed = false,
      autoSendEligible = false,
      promptInputs = {},
      model = null,
      draftedAt = new Date().toISOString()
    }) {
      requireText(bodyText, 'save requires a bodyText: an empty draft is not a draft.');

      const rows = await upsert(
        supabase,
        T.TICKET_DRAFTS,
        [
          {
            shop_id: shopId,
            ticket_id: ticketId,
            trigger_message_id: triggerMessageId,
            investigation_id: investigationId,
            source_verdict: sourceVerdict,
            level,
            language,
            subject,
            body_text: bodyText,
            checks,
            checks_passed: Boolean(checksPassed),
            auto_send_eligible: Boolean(autoSendEligible),
            prompt_inputs: promptInputs,
            model,
            drafted_at: draftedAt,
            // A revised draft has not been reviewed yet, whatever the previous
            // text's copy did. Left un-stamped so the review pass picks it up
            // again rather than the reviewer holding an email describing text
            // that no longer exists.
            review_sent_at: null
          }
        ],
        'shop_id,trigger_message_id'
      );
      return rows?.[0] ?? null;
    },

    /**
     * WHICH OF THESE MESSAGES ALREADY HAVE A DRAFT.
     *
     * The drafting queue is DERIVED, not flagged, and that is a deliberate
     * departure from how categorisation and investigation are sequenced. Those
     * two run off `needs_*` booleans on `tickets`; a third would mean adding a
     * column to a populated table, which the baseline forbids saying (there is
     * no `alter table … add column` in it at all) and which would have to be
     * applied forward by hand against the live project.
     *
     * It is affordable because the candidate set is small and bounded by the
     * case files, not by the corpus: a caller lists the trigger messages of the
     * investigations it is considering and subtracts what comes back. The
     * unique index is the real guarantee anyway — a race that drafts the same
     * message twice rewrites one row rather than creating two.
     */
    async withoutDrafts(triggerMessageIds) {
      const ids = [...new Set(triggerMessageIds.filter(Boolean))];
      if (ids.length === 0) {
        return [];
      }
      const rows = await select(
        supabase,
        T.TICKET_DRAFTS,
        { shop_id: shopId, trigger_message_id: { operator: 'in', value: `(${ids.join(',')})` } },
        'trigger_message_id'
      );
      const drafted = new Set(rows.map((row) => row.trigger_message_id));
      return ids.filter((id) => !drafted.has(id));
    },

    /**
     * The current draft for a ticket — the latest reading, which is the one a
     * reviewer is being asked about.
     *
     * Older drafts on the same ticket are kept rather than deleted (they are
     * the record of what was said to an earlier message) and are simply not
     * what this returns.
     */
    async forTicket(ticketId) {
      const rows = await select(
        supabase,
        T.TICKET_DRAFTS,
        { shop_id: shopId, ticket_id: ticketId },
        COLUMNS.draftForReview,
        { order: 'drafted_at.desc', limit: 1 }
      );
      return rows[0] || null;
    },

    /** Drafted, and no review copy sent yet. What the review-mail pass claims. */
    async pendingReview({ limit } = {}) {
      return select(
        supabase,
        T.TICKET_DRAFTS,
        { shop_id: shopId, review_sent_at: { operator: 'is', value: 'null' } },
        COLUMNS.draftForReview,
        { order: 'drafted_at.asc', limit }
      );
    },

    /**
     * Record what a person decided.
     *
     * THE REWRITE IS REQUIRED BY `edited`, in code as well as in the check
     * constraint. Both, because the constraint protects the table and this
     * protects the caller: a dashboard that sent `edited` with no body would
     * otherwise learn about it as a Postgres error surfaced through PostgREST,
     * at which point the operator's text is already gone from the form.
     *
     * `sent` IS NOT A DECISION ANYBODY CAN MAKE HERE. It is in the column's
     * check constraint so the lifecycle reads completely, and it is absent from
     * DECISIONS because nothing in this codebase can send an email to a
     * customer — accepting it would let the dashboard record a send that never
     * happened.
     */
    async decide(draftId, { status, approvedBodyText = null }) {
      if (!DECISIONS.includes(status)) {
        throw new Error(
          `decide() takes one of ${DECISIONS.join(', ')}; got ${JSON.stringify(status)}.`
        );
      }
      if (status === 'edited') {
        requireText(
          approvedBodyText,
          'decide("edited") requires the rewritten body: the edit is the thing being recorded.'
        );
      }

      return updateById(supabase, T.TICKET_DRAFTS, draftId, {
        status,
        // Carried on `approved` too when the reviewer supplied one, and null on
        // `rejected`: a rejected draft has no approved text by definition.
        approved_body_text: status === 'rejected' ? null : approvedBodyText
      });
    },

    /** A review copy of this draft reached the reviewer's inbox. */
    async markReviewSent(draftId, at = new Date().toISOString()) {
      return updateById(supabase, T.TICKET_DRAFTS, draftId, { review_sent_at: at });
    }
  };
}

function requireText(value, message) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(message);
  }
}

import {
  supabaseDelete,
  supabaseInsert,
  supabaseSelect,
  supabaseSelectAll,
  supabaseUpdateById
} from './supabase-rest-client.mjs';
import { T } from './tables.mjs';
import { caseReplyTarget, caseTimeline } from './case-reply-target.mjs';

/**
 * The case: the customer's problem, above the email threads it arrived on
 * (61_cases.sql). The only writer of `cases` and `case_links`.
 *
 * WHAT IT OWNS
 *   · creating a case (one per new conversation, at ingestion)
 *   · recording every linking decision in `case_links`, a new case included
 *   · moving a thread into another case, through the ticket record (which
 *     stays the one writer of `tickets`), and deleting a case left empty
 *   · the reply target: computed by `caseReplyTarget` from every message of
 *     every thread, and stored on the case
 *   · reading the case's conversation, across threads, in email-time order
 *   · reading the shop's issue families (configuration)
 *
 * WHAT IT DOES NOT OWN: the DECISION to link. That is agent/src/cases/, and
 * deterministic wherever it can be.
 *
 * In scripts/lib because the dashboard reads the case (linked threads, the
 * reply target) and cannot import from agent/src.
 */

/** Mirrors case_links_method_check. */
export const CASE_LINK_METHODS = Object.freeze([
  'first_contact',
  'reply_chain',
  'identical_body',
  'tracking',
  'order_family',
  'unique_match',
  'model',
  'model_off',
  'no_candidates',
  'excluded_sender',
  'backfill'
]);

/** Mirrors case_links_decision_check. */
export const CASE_LINK_DECISIONS = Object.freeze(['link', 'new_case']);

/** Mirrors tickets_case_link_state_check. */
export const CASE_LINK_STATES = Object.freeze(['pending', 'decided']);

const IS_NULL = { operator: 'is', value: 'null' };

/** What a case's conversation carries: enough for the target, the timeline and the transcript. */
export const CASE_MESSAGE_COLUMNS = 'id,ticket_id,direction,actor,subject,received_at,sent_at';

export const REST_TRANSPORT = {
  select: supabaseSelect,
  selectAll: supabaseSelectAll,
  insert: supabaseInsert,
  updateById: supabaseUpdateById,
  remove: supabaseDelete
};

/**
 * @param {any} supabase
 * @param {{ shopId: string, tickets?: any, transport?: any }} options
 *   `tickets`: the ticket record (scripts/lib/ticket-record.mjs), the only
 *   writer of `tickets`, used for the case_id move. Optional for readers.
 */
export function createCaseRecord(supabase, { shopId, tickets = null, transport = REST_TRANSPORT } = {}) {
  if (!shopId) {
    throw new Error('createCaseRecord requires a shopId: every read and write here is shop-scoped.');
  }
  const { select, selectAll, insert, updateById, remove } = transport;

  const live = (extra = {}) => ({ shop_id: shopId, deleted_at: IS_NULL, ...extra });

  const record = {
    /** A new, empty case. Its first ticket is created pointing at it. */
    async create() {
      const rows = await insert(supabase, T.CASES, [{ shop_id: shopId }]);
      return rows[0];
    },

    async find(caseId) {
      const rows = await select(supabase, T.CASES, { id: caseId, shop_id: shopId }, '*', { limit: 1 });
      return rows[0] || null;
    },

    /** Cases by id, in one read. */
    async findMany(caseIds = []) {
      const ids = [...new Set(caseIds.filter(Boolean))];
      if (ids.length === 0) return [];
      return selectAll(supabase, T.CASES, { shop_id: shopId, id: { operator: 'in', value: `(${ids.join(',')})` } }, '*');
    },

    /** The live threads of a case. */
    async threads(caseId, columns = 'id,subject,status,first_message_at,last_message_at,case_link_state') {
      return selectAll(supabase, T.TICKETS, live({ case_id: caseId }), columns, { order: 'first_message_at.asc' });
    },

    /** The live threads of several cases, in one read per hundred cases. */
    async threadsOfCases(caseIds = [], columns = 'id,case_id,status,level,last_message_at') {
      const ids = [...new Set(caseIds.filter(Boolean))];
      const rows = [];
      for (let i = 0; i < ids.length; i += 100) {
        rows.push(
          ...(await selectAll(supabase, T.TICKETS, live({ case_id: { operator: 'in', value: `(${ids.slice(i, i + 100).join(',')})` } }), columns))
        );
      }
      return rows;
    },

    /**
     * Every message of every live thread of the case, in the order the case
     * happened (the email's own time). Each row keeps its `ticket_id`, so a
     * reader can mark where the conversation changed thread.
     */
    async conversation(caseId, { columns = CASE_MESSAGE_COLUMNS } = {}) {
      const threads = await record.threads(caseId, 'id');
      if (threads.length === 0) return [];
      const wanted = columns.split(',').includes('ticket_id') ? columns : `${columns},ticket_id`;
      const rows = await selectAll(
        supabase,
        T.TICKET_MESSAGES,
        {
          shop_id: shopId,
          deleted_at: IS_NULL,
          ticket_id: { operator: 'in', value: `(${threads.map((t) => t.id).join(',')})` }
        },
        wanted
      );
      return caseTimeline(rows);
    },

    /**
     * Recomputes where the case's reply goes, and stores it. One rule, in
     * `caseReplyTarget`: the newest customer message no later message of ours
     * answers, on any thread.
     */
    async refreshTarget(caseId, { at = new Date().toISOString() } = {}) {
      // A THREAD STILL FLAGGED AS A DUPLICATE (`duplicate_of_ticket_id`, the
      // links 61 folded into cases) is never investigated or drafted. Its copy
      // of the message must not become the target, or the case's real thread
      // is skipped as « not the reply thread » and nobody answers at all.
      const duplicates = new Set(
        (await record.threads(caseId, 'id,duplicate_of_ticket_id')).filter((t) => t.duplicate_of_ticket_id).map((t) => t.id)
      );
      const messages = (await record.conversation(caseId)).filter((m) => !duplicates.has(m.ticket_id));
      const target = caseReplyTarget(messages);
      await updateById(supabase, T.CASES, caseId, {
        latest_actionable_inbound_message_id: target?.messageId ?? null,
        reply_thread_id: target?.threadId ?? null,
        target_computed_at: at
      });
      return target;
    },

    /**
     * Recomputes the target of every case these threads belong to, once per
     * case. What the worker calls after the fold, and `cases:targets` over all.
     */
    async refreshTargetsForTickets(ticketIds = [], options = {}) {
      const ids = [...new Set(ticketIds.filter(Boolean))];
      const caseIds = new Set();
      for (let i = 0; i < ids.length; i += 100) {
        const rows = await selectAll(
          supabase,
          T.TICKETS,
          { shop_id: shopId, id: { operator: 'in', value: `(${ids.slice(i, i + 100).join(',')})` } },
          'id,case_id'
        );
        for (const row of rows) if (row.case_id) caseIds.add(row.case_id);
      }
      const targets = new Map();
      for (const caseId of caseIds) targets.set(caseId, await record.refreshTarget(caseId, options));
      return targets;
    },

    /** Records a decision. Append-only: nothing here updates a case_links row. */
    async recordDecision({ ticketId, fromCaseId, toCaseId, decision, method, candidates = [], model = null, modelAnswer = null }) {
      if (!CASE_LINK_DECISIONS.includes(decision)) throw new Error(`Unknown case-link decision: ${decision}`);
      if (!CASE_LINK_METHODS.includes(method)) throw new Error(`Unknown case-link method: ${method}`);
      if ((decision === 'link') !== (fromCaseId !== toCaseId)) {
        throw new Error('A link moves a thread to another case; a new case keeps it where it is.');
      }
      const rows = await insert(supabase, T.CASE_LINKS, [
        {
          shop_id: shopId,
          ticket_id: ticketId,
          from_case_id: fromCaseId,
          to_case_id: toCaseId,
          decision,
          method,
          candidates,
          model,
          model_answer: modelAnswer
        }
      ]);
      return rows[0];
    },

    /**
     * Applies a decision: records it, moves the thread when it links, marks
     * the thread decided, and deletes the case it left if nothing else points
     * at it. The thread's messages never move.
     */
    async applyDecision({ ticketId, fromCaseId, toCaseId, method, candidates = [], model = null, modelAnswer = null, ticketColumns = {} }) {
      if (!tickets) throw new Error('applyDecision needs the ticket record: it is the only writer of tickets.');
      const decision = toCaseId && toCaseId !== fromCaseId ? 'link' : 'new_case';
      const target = decision === 'link' ? toCaseId : fromCaseId;
      await record.recordDecision({ ticketId, fromCaseId, toCaseId: target, decision, method, candidates, model, modelAnswer });
      await tickets.setCase(ticketId, { caseId: target, state: 'decided', columns: decision === 'link' ? ticketColumns : {} });
      if (decision === 'link') await record.deleteIfEmpty(fromCaseId);
      return { decision, caseId: target };
    },

    /** The case key (`customer | order | family`) and family, once known. */
    async setKey(caseId, { caseKey, issueFamily = null }) {
      return updateById(supabase, T.CASES, caseId, { case_key: caseKey, issue_family: issueFamily });
    },

    /** Deletes a case no thread points at. A case that still has one is left alone. */
    async deleteIfEmpty(caseId) {
      const rows = await select(supabase, T.TICKETS, { shop_id: shopId, case_id: caseId }, 'id', { limit: 1 });
      if (rows.length > 0) return false;
      await remove(supabase, T.CASES, { id: caseId, shop_id: shopId });
      return true;
    },

    /** The decisions recorded for these threads, newest first. */
    async decisionsFor(ticketIds = []) {
      const ids = [...new Set(ticketIds.filter(Boolean))];
      if (ids.length === 0) return [];
      return selectAll(
        supabase,
        T.CASE_LINKS,
        { shop_id: shopId, ticket_id: { operator: 'in', value: `(${ids.join(',')})` } },
        'ticket_id,from_case_id,to_case_id,decision,method,decided_at',
        { order: 'decided_at.desc' }
      );
    },

    /**
     * The shop's issue families: which family each subject and situation is in,
     * and which family may become which. Configuration, read per run.
     */
    async families() {
      const [members, transitions] = await Promise.all([
        selectAll(supabase, T.ISSUE_FAMILY_MEMBERS, { shop_id: shopId }, 'member_kind,member_key,family_key'),
        selectAll(supabase, T.ISSUE_FAMILY_TRANSITIONS, { shop_id: shopId }, 'from_family,to_family')
      ]);
      return issueFamiliesFrom(members, transitions);
    }
  };
  return record;
}

/** The rows of the two family tables, as the shape the linking rules read. */
export function issueFamiliesFrom(members = [], transitions = []) {
  const subjects = {};
  const situations = {};
  for (const row of members) {
    if (row.member_kind === 'subject') subjects[row.member_key] = row.family_key;
    else if (row.member_kind === 'situation') situations[row.member_key] = row.family_key;
  }
  return {
    subjects,
    situations,
    transitions: transitions.map((row) => [row.from_family, row.to_family])
  };
}

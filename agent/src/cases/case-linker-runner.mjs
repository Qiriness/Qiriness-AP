// The `link` pass: decides, once per new thread, whether it continues one of
// the customer's existing cases. Runs after categorisation and the order
// passes (the subject, order and parcel are what it decides on) and before the
// investigation (which then reads the whole case).
//
// THE FLOW, and where a model may appear:
//   identify the customer (requester hash)                 deterministic
//   a listed sender, or one of our own threads?  -> new    deterministic
//   no other case of this customer in the window -> new    deterministic
//   identifiers: order, parcel, family                     deterministic
//   plausible candidates, at most MAX_CANDIDATES           deterministic
//                                                          (embedding: retrieval only)
//   tracking / order + family / unique match     -> link   deterministic
//   still plausible candidates                   -> the Case Linker, if on;
//                                                   otherwise a new case, logged
//   nothing plausible                            -> new    deterministic
// Then the thread is moved (or not), the decision is recorded, and the target
// case's reply target is recomputed.

import { supabaseSelectAll } from '../../../scripts/lib/supabase-rest-client.mjs';
import { T, V } from '../../../scripts/lib/tables.mjs';
import { reinvestigationColumns } from '../../../scripts/lib/order-link.mjs';
import { caseKey, compatibleFamilies, decideLink, familyOf } from './case-link-rules.mjs';
import { cosine, RELATED_THRESHOLD, toVector } from '../ingestion/related-rules.mjs';
import { parseTrackingCandidates } from '../resolution/tracking-number-parser.mjs';

/** How far back another case of the customer can be and still be continued. */
export const CASE_LINK_WINDOW_DAYS = 60;

/** The Case Linker is shown at most this many cases. */
export const MAX_CANDIDATES = 5;

/** How much of a candidate case's opening customer message the Case Linker reads. */
export const CANDIDATE_OPENING_CHARS = 400;

/** Why a case was retrieved, strongest first: the ranking and the audit both read it. */
export const CANDIDATE_REASONS = Object.freeze(['same_tracking', 'same_order', 'similar_message', 'compatible_family']);

/**
 * The customer's plausible cases, ranked, cut to MAX_CANDIDATES.
 *
 * PLAUSIBLE means at least one reason: the same parcel, the same order, a
 * message the embedding scores as the same conversation, or a family this
 * thread's family may continue. A case that is merely recent and from the same
 * person is not a candidate: the same sender never links on its own.
 */
export function plausibleCandidates({ thread, cases, transitions = [], similarity = new Map() }) {
  const order = thread.orderNumber ? String(thread.orderNumber).replace(/^#/, '') : null;
  const tracking = new Set(thread.trackingNumbers ?? []);
  const scored = [];
  for (const candidate of cases) {
    const reasons = [];
    if ((candidate.trackingNumbers ?? []).some((number) => tracking.has(number))) reasons.push('same_tracking');
    if (order && (candidate.orderNumbers ?? []).map((n) => String(n).replace(/^#/, '')).includes(order)) reasons.push('same_order');
    if ((similarity.get(candidate.caseId) ?? 0) >= RELATED_THRESHOLD) reasons.push('similar_message');
    if (compatibleFamilies(candidate.family, thread.family, transitions)) reasons.push('compatible_family');
    if (reasons.length === 0) continue;
    scored.push({ ...candidate, reasons });
  }
  const rank = (candidate) => Math.min(...candidate.reasons.map((reason) => CANDIDATE_REASONS.indexOf(reason)));
  scored.sort(
    (a, b) => rank(a) - rank(b) || String(b.lastMessageAt ?? '').localeCompare(String(a.lastMessageAt ?? ''))
  );
  return scored.slice(0, MAX_CANDIDATES);
}

/**
 * @param store   createCaseLinkStore(...)
 * @param cases   the case record (scripts/lib/case-record.mjs)
 * @param linkCase the Case Linker (case-linker-model.mjs), or null when off
 */
export async function runCaseLinking({ store, cases, linkCase = null, limit = 200, dryRun = false, ticketId = null, logger = null }) {
  const counts = { examined: 0, linked: 0, newCases: 0, ambiguous: 0, modelCalls: 0, failed: 0, byMethod: {} };
  const tickets = await store.pending({ limit, ticketId });
  if (tickets.length === 0) return { ...counts, decisions: [] };

  const families = await cases.families();
  const decisions = [];

  for (const ticket of tickets) {
    counts.examined += 1;
    try {
      const context = await store.contextFor(ticket, { families });
      let outcome = decideLink({ thread: context.thread, candidates: context.candidates, transitions: families.transitions });
      let model = null;
      let modelAnswer = null;

      if (outcome.decision === 'ambiguous') {
        counts.ambiguous += 1;
        if (linkCase) {
          counts.modelCalls += 1;
          try {
            const answer = await linkCase({
              ticketId: ticket.id,
              subject: ticket.subject,
              body: context.opening?.body_text ?? '',
              identifiers: context.thread,
              candidates: context.candidates
            });
            model = answer.model ?? null;
            modelAnswer = answer.answer ?? null;
            outcome = answer.decision === 'link'
              ? { decision: 'link', caseId: answer.caseId, method: 'model' }
              : { decision: 'new_case', method: 'model' };
          } catch (error) {
            // A failed call is a new case: the thread stays whole and is
            // answered on its own, which is what it was before cases existed.
            logger?.warn?.('cases.linker_failed', { ticketId: ticket.id, reason: error.message });
            outcome = { decision: 'new_case', method: 'model_off' };
          }
        } else {
          outcome = { decision: 'new_case', method: 'model_off' };
        }
      }

      counts.byMethod[outcome.method] = (counts.byMethod[outcome.method] ?? 0) + 1;
      const candidates = context.candidates.map((candidate) => ({ case_id: candidate.caseId, reasons: candidate.reasons }));
      const entry = {
        ticketId: ticket.id,
        fromCaseId: ticket.case_id,
        toCaseId: outcome.decision === 'link' ? outcome.caseId : ticket.case_id,
        decision: outcome.decision,
        method: outcome.method,
        candidates
      };
      decisions.push(entry);

      if (outcome.decision === 'link') counts.linked += 1;
      else counts.newCases += 1;
      if (dryRun) continue;

      await cases.applyDecision({
        ticketId: ticket.id,
        fromCaseId: ticket.case_id,
        toCaseId: entry.toCaseId,
        method: outcome.method,
        candidates,
        model,
        modelAnswer,
        // Investigated before it joined the case: read it again, against the case.
        ticketColumns: reinvestigationColumns(ticket)
      });
      await cases.refreshTarget(entry.toCaseId);
      if (outcome.decision === 'link' && typeof store.wakeCase === 'function') {
        await store.wakeCase(entry.toCaseId, ticket.id);
      }
      const key = caseKey({ customerKey: ticket.requester_email_hash, orderNumber: context.thread.orderNumber, family: context.thread.family });
      if (key && typeof store.setCaseKey === 'function') {
        await store.setCaseKey(entry.toCaseId, { caseKey: key, family: context.thread.family });
      }
      logger?.info?.('cases.decided', { ticketId: ticket.id, decision: outcome.decision, method: outcome.method, caseId: entry.toCaseId });
    } catch (error) {
      counts.failed += 1;
      logger?.warn?.('cases.link_failed', { ticketId: ticket.id, reason: error.message });
    }
  }
  return { ...counts, decisions };
}

const IS_NULL = { operator: 'is', value: 'null' };
const inList = (values) => ({ operator: 'in', value: `(${values.map((v) => `"${String(v).replaceAll('"', '\\"')}"`).join(',')})` });

/** The situation an investigation settled on, if it recorded one. */
export function situationOf(investigation) {
  const match = investigation?.exemplar_match;
  if (!match || typeof match !== 'object') return null;
  if (typeof match.policy?.situation_key === 'string') return match.policy.situation_key;
  return typeof match.exemplar_key === 'string' ? match.exemplar_key : null;
}

/**
 * Everything the pass reads, behind one interface so the runner is tested
 * without a database.
 *
 * WHO THE CUSTOMER IS: the requester hash. Not `customer_id`: marketplace
 * orders mint one synthetic customer per order, and the hash is what the
 * duplicate and related lookups were measured on (24% of pairs have no
 * customer_id). Never the display name.
 */
// `before`: only threads that began before this instant are candidates. The
// replay (`cases:replay`) sets it to decide each stored thread as if it had
// just arrived; the worker leaves it null.
// `caseOf(ticketId)`: the case a stored thread would be in by now. The replay
// sets it so an earlier thread it linked counts as part of its target case,
// the way the live pass would have left it; null keeps the stored case.
export function createCaseLinkStore(supabase, { shopId, tickets, cases, senderDirectory = null, windowDays = CASE_LINK_WINDOW_DAYS, now = () => new Date(), select = supabaseSelectAll, snoozes = null, before = null, caseOf = null }) {
  return {
    async pending({ limit, ticketId = null }) {
      const rows = await tickets.findAwaitingCaseLink({ limit });
      return ticketId ? rows.filter((row) => row.id === ticketId) : rows;
    },

    async contextFor(ticket, { families }) {
      const [opening] = await select(
        supabase,
        V.TICKET_FIRST_INBOUND,
        { shop_id: shopId, ticket_id: ticket.id },
        'ticket_id,message_id,subject,body_text,from_email,received_at',
        // The view has no `id`, which is what a paged read sorts on by default.
        { order: 'ticket_id.asc' }
      );
      const excluded = Boolean(ticket.sender_label) || Boolean(opening?.from_email && senderDirectory?.lookup?.(opening.from_email));

      const order = ticket.shopify_order_number ?? null;
      const ownTracking = new Set(parseTrackingCandidates(`${ticket.subject ?? ''}\n${opening?.body_text ?? ''}`).map((c) => c.trackingNumber));
      const thread = {
        excluded,
        hasPriorCases: false,
        orderNumber: order,
        trackingNumbers: [],
        family: familyOf({ subject: ticket.category }, families)
      };

      if (excluded || !ticket.requester_email_hash) {
        if (order) for (const number of await trackingFor([order])) ownTracking.add(number);
        return { thread: { ...thread, trackingNumbers: [...ownTracking] }, candidates: [], opening };
      }

      const since = new Date(now().getTime() - windowDays * 86400000).toISOString();
      const others = (
        await select(
          supabase,
          T.TICKETS,
          {
            shop_id: shopId,
            deleted_at: IS_NULL,
            requester_email_hash: ticket.requester_email_hash,
            last_message_at: { operator: 'gte', value: since },
            ...(before ? { first_message_at: { operator: 'lt', value: before } } : {})
          },
          'id,case_id,subject,status,category,shopify_order_number,last_message_at'
        )
      )
        .map((row) => ({ ...row, case_id: caseOf?.(row.id) ?? row.case_id }))
        .filter((row) => row.case_id && row.case_id !== ticket.case_id);

      const orderNames = [...new Set([order, ...others.map((row) => row.shopify_order_number)].filter(Boolean))];
      const trackingByOrder = await trackingMap(orderNames);
      if (order) for (const number of trackingByOrder.get(normal(order)) ?? []) ownTracking.add(number);
      thread.trackingNumbers = [...ownTracking];
      thread.hasPriorCases = others.length > 0;
      if (others.length === 0) return { thread, candidates: [], opening };

      // The latest situation of each candidate thread, to read its family.
      const investigations = await select(
        supabase,
        T.TICKET_INVESTIGATIONS,
        { shop_id: shopId, ticket_id: inList(others.map((row) => row.id)) },
        'ticket_id,exemplar_match,investigated_at',
        { order: 'investigated_at.desc' }
      );
      const situationByTicket = new Map();
      for (const row of investigations) {
        if (!situationByTicket.has(row.ticket_id)) situationByTicket.set(row.ticket_id, situationOf(row));
      }

      // What each case's customer first wrote, cut: the Case Linker reads it.
      // Subjects alone ("Nouveau message de client le …") left it guessing.
      const openings = await select(
        supabase,
        V.TICKET_FIRST_INBOUND,
        { shop_id: shopId, ticket_id: inList(others.map((row) => row.id)) },
        'ticket_id,body_text,received_at',
        { order: 'ticket_id.asc' }
      );
      const openingByTicket = new Map(openings.map((row) => [row.ticket_id, row]));

      const byCase = new Map();
      for (const row of others) {
        const entry = byCase.get(row.case_id) ?? { caseId: row.case_id, threads: [] };
        entry.threads.push(row);
        byCase.set(row.case_id, entry);
      }
      const caseRows = [...byCase.values()].map(({ caseId, threads }) => {
        threads.sort((a, b) => String(b.last_message_at ?? '').localeCompare(String(a.last_message_at ?? '')));
        const latest = threads[0];
        const situationKey = threads.map((t) => situationByTicket.get(t.id)).find(Boolean) ?? null;
        const orderNumbers = [...new Set(threads.map((t) => t.shopify_order_number).filter(Boolean))];
        const [firstOpening] = threads
          .map((t) => openingByTicket.get(t.id))
          .filter((row) => row?.body_text)
          .sort((a, b) => String(a.received_at ?? '').localeCompare(String(b.received_at ?? '')));
        return {
          caseId,
          family: familyOf({ subject: latest.category, situation: situationKey }, families),
          situationKey,
          orderNumbers,
          trackingNumbers: [...new Set(orderNumbers.flatMap((n) => trackingByOrder.get(normal(n)) ?? []))],
          lastMessageAt: latest.last_message_at,
          summary: threads.map((t) => `${t.subject ?? '(sans objet)'} [${t.status}]`).join(' · '),
          opening: firstOpening ? excerpt(firstOpening.body_text) : null,
          ticketIds: threads.map((t) => t.id)
        };
      });

      const similarity = await similarityByCase(ticket.id, caseRows);
      const candidates = plausibleCandidates({ thread, cases: caseRows, transitions: families.transitions, similarity });
      return { thread, candidates, opening };
    },

    /** The case's threads wake: a thread joining it is the case coming back. */
    async wakeCase(caseId, joinedTicketId) {
      if (!snoozes) return;
      const threads = await cases.threads(caseId, 'id');
      for (const thread of threads) {
        if (thread.id === joinedTicketId) continue;
        await snoozes.wake(thread.id, 'case_changed');
      }
    },

    async setCaseKey(caseId, { caseKey: key, family }) {
      await cases.setKey(caseId, { caseKey: key, issueFamily: family });
    }
  };

  function excerpt(text) {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
    return flat.length > CANDIDATE_OPENING_CHARS ? `${flat.slice(0, CANDIDATE_OPENING_CHARS)}…` : flat;
  }

  function normal(order) {
    return String(order).replace(/^#/, '');
  }

  async function trackingMap(orderNames) {
    const map = new Map();
    if (orderNames.length === 0) return map;
    const names = [...new Set(orderNames.flatMap((n) => [`#${normal(n)}`, normal(n)]))];
    const rows = await select(supabase, T.ORDERS, { shop_id: shopId, name: inList(names) }, 'name,tracking_numbers');
    for (const row of rows) map.set(normal(row.name), row.tracking_numbers ?? []);
    return map;
  }

  async function trackingFor(orderNames) {
    const map = await trackingMap(orderNames);
    return [...map.values()].flat();
  }

  /**
   * The best cosine between this thread's inbound messages and each candidate
   * case's. RETRIEVAL ONLY: it can make a case a candidate, never link it.
   */
  async function similarityByCase(ticketId, caseRows) {
    const result = new Map();
    const otherIds = caseRows.flatMap((row) => row.ticketIds);
    if (otherIds.length === 0) return result;
    const rows = await select(
      supabase,
      T.TICKET_MESSAGES,
      { shop_id: shopId, direction: 'inbound', deleted_at: IS_NULL, ticket_id: inList([ticketId, ...otherIds]) },
      'ticket_id,embedding'
    );
    const mine = rows.filter((row) => row.ticket_id === ticketId).map((row) => toVector(row.embedding)).filter(Boolean);
    if (mine.length === 0) return result;
    const caseOf = new Map(caseRows.flatMap((row) => row.ticketIds.map((id) => [id, row.caseId])));
    for (const row of rows) {
      const caseId = caseOf.get(row.ticket_id);
      const vector = toVector(row.embedding);
      if (!caseId || !vector) continue;
      const best = Math.max(...mine.map((own) => cosine(own, vector)));
      if (best > (result.get(caseId) ?? 0)) result.set(caseId, best);
    }
    return result;
  }
}

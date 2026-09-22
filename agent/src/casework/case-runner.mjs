import { supabaseSelect } from '../../../scripts/lib/supabase-rest-client.mjs';
import { COLUMNS, T } from '../../../scripts/lib/tables.mjs';

import { readCase } from './case-manager.mjs';
import { evidenceReuseFrom, pendingAfter, situationFor } from './case-manager-rules.mjs';

// The casework pass: what the newest message changed about a case already read.
//
// WHERE IT SITS. After customer resolution, before categorisation — because the
// one decision it feeds is whether the categoriser needs to re-read the labels
// at all, and that has to be known before the categoriser claims its batch.
// This moves the `--stop-after=categorise` boundary, which `poll-order.test.mjs`
// pins and which `index.mjs` documents; both were updated deliberately.
//
// THE QUEUE IS DERIVED, with no third `needs_*` flag. A ticket is due a reading
// when it has a PRIOR case file and its newest inbound message has no reading
// yet. That is two reads and a set subtraction, against a column on a populated
// table and a migration — the same trade `draft-record.withoutDrafts` made.
//
// A GENUINELY NEW CASE MATCHES NOTHING, which is the requirement stated in the
// brief: with no prior case file there is nothing for a message to change, and
// the classifier already does this job for a first message.
//
// IT WRITES ONE TABLE. `ticket_case_state`, through its own record module.
// Ticket flags stay with `ticket-record.mjs`: this pass hands the categoriser a
// predicate and the categoriser completes its own pass, so no second writer of
// `needs_categorisation` comes into existence.

const DEFAULT_BATCH_LIMIT = 25;

export async function runCasework({
  store,
  record,
  caseStateRecord,
  openai,
  model,
  shopId,
  senderDirectory = null,
  logger,
  limit = DEFAULT_BATCH_LIMIT,
  ticketId = null,
  dryRun = false,
  onReading
}) {
  const counts = { considered: 0, read: 0, skipped: 0, failed: 0, byRelationship: {} };
  const candidates = await store.claimable({ shopId, limit, ticketId });
  counts.considered = candidates.length;

  for (const candidate of candidates) {
    const { ticket, message, previous, investigation } = candidate;

    const conversation = await record.conversation(ticket.id, { columns: COLUMNS.threadForDrafting });
    const pendingInputs = previous?.pending_customer_inputs ?? missingFieldsOf(investigation);

    const reading = await readCase({
      openai,
      model,
      ticket,
      message,
      conversation,
      pendingInputs,
      previousSummary: previous?.case_summary ?? null,
      senderDirectory,
      logger
    });

    if (reading.failed) {
      // NOT A SKIP AND NOT A FAILURE OF THE TICKET. `unclear` is stored, which
      // is the value that changes nothing: the categoriser re-runs, the
      // situation is re-matched, and the pipeline behaves as it did before this
      // pass existed. Counted so a run of failures is visible rather than
      // reading as a thread nobody could place.
      counts.failed += 1;
    }

    const situationKey = situationFor({
      caseRelationship: reading.caseRelationship,
      previousSituationKey: previous?.situation_key ?? investigation?.exemplar_match?.exemplar_key ?? null
    });

    const stored = {
      ticketId: ticket.id,
      triggerMessageId: message.id,
      caseRelationship: reading.caseRelationship,
      situationKey,
      resolvedInputs: reading.resolvedInputs,
      pendingCustomerInputs: pendingAfter({
        previousPending: pendingInputs,
        resolvedInputs: reading.resolvedInputs
      }),
      newFacts: reading.newFacts,
      commitments: reading.commitments,
      contradictions: reading.contradictions,
      evidenceReuse: evidenceReuseFrom({
        toolCalls: investigation?.tool_calls ?? [],
        findings: findingsOf(investigation),
        orderChanged: false,
        runAt: investigation?.investigated_at ?? null
      }),
      caseSummary: reading.caseSummary,
      model
    };

    if (!dryRun) {
      await caseStateRecord.save(stored);
    }

    counts.read += 1;
    counts.byRelationship[reading.caseRelationship] =
      (counts.byRelationship[reading.caseRelationship] || 0) + 1;
    onReading?.({ ticket, reading: stored });

    logger?.info?.('casework.read', {
      ticketId: ticket.id,
      relationship: reading.caseRelationship,
      resolved: stored.resolvedInputs.length,
      pending: stored.pendingCustomerInputs.length,
      situation: situationKey
    });
  }

  return counts;
}

/**
 * The questions the last case file named, for a thread with no prior reading.
 *
 * The first follow-up on an existing ticket has a case file but no case state,
 * so what we asked for lives only in `missing`. After that the case state
 * carries it, which is the point.
 */
function missingFieldsOf(investigation) {
  return (investigation?.missing ?? []).map((item) => item?.field).filter(Boolean);
}

/** The findings the last run resolved, as `evidence_reuse` is built from. */
function findingsOf(investigation) {
  const trace = investigation?.findings_trace;
  if (!Array.isArray(trace) || trace.length === 0) return {};
  return trace[trace.length - 1]?.findings ?? {};
}

/**
 * Which tickets are due a reading.
 *
 * TWO CONDITIONS, AND BOTH ARE THE POINT. A prior case file, so a genuinely new
 * case is never read here. And no reading yet for the NEWEST inbound message,
 * which is what makes the queue derived rather than flagged.
 */
export function createCaseworkStore(supabase, { caseStateRecord }) {
  return {
    async claimable({ shopId, limit, ticketId = null }) {
      const filters = {
        shop_id: shopId,
        needs_categorisation: { operator: 'is', value: 'true' },
        deleted_at: { operator: 'is', value: 'null' },
        archived_at: { operator: 'is', value: 'null' }
      };
      if (ticketId) filters.id = ticketId;

      const tickets = await supabaseSelect(supabase, T.TICKETS, filters, COLUMNS.ticketForCategorisation, {
        order: 'first_message_at.asc'
      });
      if (tickets.length === 0) return [];

      // A PRIOR CASE FILE IS WHAT MAKES THIS AN EXISTING CASE. Read newest
      // first so the row kept per ticket is the most recent reading.
      const investigations = await supabaseSelect(
        supabase,
        T.TICKET_INVESTIGATIONS,
        {
          shop_id: shopId,
          ticket_id: { operator: 'in', value: `(${tickets.map((row) => row.id).join(',')})` }
        },
        COLUMNS.investigationForCasework,
        { order: 'investigated_at.desc' }
      );
      const latestInvestigation = new Map();
      for (const row of investigations) {
        if (!latestInvestigation.has(row.ticket_id)) latestInvestigation.set(row.ticket_id, row);
      }

      const candidates = [];
      for (const ticket of tickets) {
        const investigation = latestInvestigation.get(ticket.id);
        if (!investigation) continue;

        const inbound = await supabaseSelect(
          supabase,
          T.TICKET_MESSAGES,
          { ticket_id: ticket.id, direction: 'inbound', deleted_at: { operator: 'is', value: 'null' } },
          COLUMNS.messageForDrafting,
          { order: 'received_at.desc', limit: 1 }
        );
        const message = inbound[0];
        // The message the last case file was already written from is not new.
        if (!message || message.id === investigation.trigger_message_id) continue;

        candidates.push({ ticket, message, investigation });
      }

      const done = await caseStateRecord.withCaseState(candidates.map((c) => c.message.id));
      const due = candidates.filter((c) => !done.has(c.message.id));

      for (const candidate of due) {
        candidate.previous = await caseStateRecord.latest(candidate.ticket.id);
      }
      return typeof limit === 'number' ? due.slice(0, limit) : due;
    }
  };
}

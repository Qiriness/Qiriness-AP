import { ratchetLevel } from '../../../scripts/lib/support-taxonomy.mjs';
import {
  supabaseSelect,
  supabaseUpdate,
  supabaseUpdateById,
  supabaseUpsert
} from '../../../scripts/lib/supabase-rest-client.mjs';

import { ENABLED_SUBJECTS, isInvestigable } from './investigation-rules.mjs';

// The batch pass that investigates categorised tickets, mirroring
// `categorise-runner.mjs` in every structural respect — because the problems are
// the same ones: a queue that must be catch-up-safe, a model call that can fail,
// and a fallback that has to land in front of a human rather than nowhere.
//
// THE TRIGGER IS THE CATEGORISER FINISHING. It sets `needs_investigation` in the
// same patch that clears `needs_categorisation`, and this pass drains that queue
// later in the same poll. Ingestion does NOT raise the flag itself: a new inbound
// message raises `needs_categorisation`, the categoriser re-labels the thread and
// then re-raises this one. One writer, and no window in which a ticket is
// investigated against labels that describe an older conversation.
//
// Out-of-scope subjects (see ENABLED_SUBJECTS) are skipped and their flag is
// CLEARED — the same reasoning as the categoriser's "thread with no customer
// message": leaving them pending parks them at the front of an oldest-first
// batch for good. Enabling a subject later therefore means re-raising the flag
// for its existing tickets (one update), not just editing the array.

const DEFAULT_BATCH_LIMIT = 10;
const MAX_ATTEMPTS = 3;
const MESSAGES_PER_TICKET = 10;
const MAX_TEXT_CHARS = 4000;

export async function runInvestigation({
  store,
  investigate,
  shopId,
  logger,
  limit = DEFAULT_BATCH_LIMIT,
  dryRun = false,
  onResult
} = {}) {
  const counts = {
    considered: 0,
    answerable: 0,
    needs_customer_input: 0,
    needs_human: 0,
    skipped: 0,
    failed: 0
  };

  const pending = await store.findTicketsNeedingInvestigation(shopId, limit);
  counts.considered = pending.length;

  for (const ticket of pending) {
    if (!isInvestigable(ticket)) {
      // Not a failure: the order family has no synced data to investigate yet,
      // and cosmetovigilance / legal_privacy are deliberately left to a person.
      if (!dryRun) {
        await store.updateTicket(ticket.id, { needs_investigation: false });
      }
      counts.skipped += 1;
      continue;
    }

    const messages = await store.findInboundMessages(ticket.id, MESSAGES_PER_TICKET);
    if (messages.length === 0) {
      if (!dryRun) {
        await store.updateTicket(ticket.id, { needs_investigation: false });
      }
      counts.skipped += 1;
      continue;
    }

    let caseFile;
    try {
      caseFile = await investigate(buildInput(ticket, messages));
    } catch (error) {
      await handleFailure({ store, ticket, error, counts, logger, dryRun });
      continue;
    }

    // The level may rise on what the evidence showed, never fall — the same
    // ratchet the categoriser uses, for the same reason.
    const level = ratchetLevel(ticket.level, caseFile.proposedLevel);

    counts[caseFile.verdict] += 1;
    onResult?.({ ticket, caseFile, level });

    if (!dryRun) {
      await store.saveInvestigation({
        ticket,
        caseFile,
        shopId,
        triggerMessageId: messages[messages.length - 1].id,
        level
      });
    }

    // No PII: ids, verdicts and counts only. The claims themselves stay in the
    // row, which is access-controlled; a log line is not.
    logger?.info?.('investigate.ticket', {
      ticketId: ticket.id,
      category: ticket.category,
      verdict: caseFile.verdict,
      established: caseFile.established.length,
      missing: caseFile.missing.length,
      dropped: caseFile.droppedClaims.length,
      toolCalls: caseFile.toolCalls.length,
      ...(level !== ticket.level ? { handlingLevel: level, previousHandlingLevel: ticket.level } : {})
    });
  }

  return counts;
}

/**
 * A failed investigation is retried, then given up on — towards a human.
 *
 * Identical in shape to the categoriser's failure path, and for the identical
 * reason: a ticket that fails forever must not occupy a batch slot on every
 * poll, and what it becomes when we stop trying must be visible rather than
 * silent. There is no partial case file to keep, so the fallback is simply
 * "a person should look at this, and here is why".
 */
async function handleFailure({ store, ticket, error, counts, logger, dryRun }) {
  const attempts = attemptsSoFar(ticket.metadata) + 1;
  counts.failed += 1;
  logger?.warn?.('investigate.error', { ticketId: ticket.id, attempts, message: error.message });

  if (dryRun) {
    return;
  }

  if (attempts < MAX_ATTEMPTS) {
    await store.updateTicket(ticket.id, {
      metadata: mergeMetadata(ticket.metadata, {
        attempts,
        last_error: error.message,
        at: new Date().toISOString()
      })
    });
    return;
  }

  await store.updateTicket(ticket.id, {
    needs_investigation: false,
    investigated_at: new Date().toISOString(),
    metadata: mergeMetadata(ticket.metadata, {
      attempts,
      failed: true,
      last_error: error.message,
      verdict: 'needs_human',
      reason: 'investigation failed, routed to a human',
      at: new Date().toISOString()
    })
  });
  logger?.error?.('investigate.fallback', { ticketId: ticket.id, attempts });
}

/**
 * What the agent is given.
 *
 * First and latest inbound, as the categoriser does: the first says what was
 * originally asked (and is where a product name or a discount code is actually
 * written), the latest says where the customer stands now. The middle of a long
 * thread rarely changes either.
 */
function buildInput(ticket, messages) {
  const first = messages[0];
  const latest = messages.length > 1 ? messages[messages.length - 1] : null;
  const text = [first?.body_text, latest?.body_text]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, MAX_TEXT_CHARS);

  return {
    id: ticket.id,
    subject: ticket.subject,
    text,
    category: ticket.category,
    request_kind: ticket.request_kind,
    level: ticket.level,
    customer_id: ticket.customer_id,
    requester_email_hash: ticket.requester_email_hash,
    shopify_order_number: ticket.shopify_order_number,
    // The bundle the order-context pass already assembled and stored. Read, not
    // re-derived: a second derivation of the same order would be a second,
    // divergent account of it.
    resolvedContext: ticket.resolved_context && Object.keys(ticket.resolved_context).length > 0
      ? ticket.resolved_context
      : null
  };
}

function attemptsSoFar(metadata) {
  const attempts = metadata?.investigation?.attempts;
  return Number.isInteger(attempts) ? attempts : 0;
}

// One jsonb column shared with the categoriser and the customer resolver, so
// patch this key rather than replacing the object.
function mergeMetadata(metadata, investigation) {
  const base = metadata && typeof metadata === 'object' ? metadata : {};
  return { ...base, investigation: { ...base.investigation, ...investigation } };
}

export function createInvestigationStore(supabase) {
  return {
    /**
     * The queue.
     *
     * `needs_categorisation` must be false as well: a ticket whose labels are
     * still pending would be investigated with a tool set chosen from the
     * previous conversation's subject. Within a poll the categoriser runs first
     * and this cannot happen; the filter covers the cases it does not own — no
     * OpenAI key, a batch that did not drain, a flag set by hand.
     */
    async findTicketsNeedingInvestigation(shopId, limit) {
      return supabaseSelect(
        supabase,
        'tickets',
        {
          shop_id: shopId,
          status: 'open',
          needs_investigation: { operator: 'is', value: 'true' },
          needs_categorisation: { operator: 'is', value: 'false' },
          deleted_at: { operator: 'is', value: 'null' },
          archived_at: { operator: 'is', value: 'null' }
        },
        'id,subject,category,request_kind,level,customer_id,requester_email_hash,' +
          'shopify_order_number,resolved_context,metadata',
        { order: 'first_message_at.asc', limit }
      );
    },

    async findInboundMessages(ticketId, limit) {
      return supabaseSelect(
        supabase,
        'ticket_messages',
        {
          ticket_id: ticketId,
          direction: 'inbound',
          deleted_at: { operator: 'is', value: 'null' }
        },
        'id,subject,body_text,received_at',
        { order: 'received_at.asc', limit }
      );
    },

    /**
     * Writes the case file and closes the ticket's investigation.
     *
     * The row is upserted on `(shop_id, trigger_message_id)`: one investigation
     * per inbound message that caused it. That is the idempotency key — a
     * re-run over the same thread rewrites its own row rather than adding a
     * second — and it leaves the ticket's trajectory as rows, so a thread that
     * escalated shows both readings.
     */
    async saveInvestigation({ ticket, caseFile, shopId, triggerMessageId, level }) {
      await supabaseUpsert(
        supabase,
        'ticket_investigations',
        [
          {
            shop_id: shopId,
            ticket_id: ticket.id,
            customer_id: ticket.customer_id || null,
            trigger_message_id: triggerMessageId,
            verdict: caseFile.verdict,
            established: caseFile.established,
            unverified: caseFile.unverified,
            missing: caseFile.missing,
            do_not_claim: caseFile.doNotClaim,
            knowledge: caseFile.knowledge,
            context_ref: caseFile.contextRef || {},
            handoff: caseFile.handoff,
            tool_calls: caseFile.toolCalls,
            dropped_claims: caseFile.droppedClaims,
            escalation_reasons: caseFile.escalationReasons,
            proposed_level: caseFile.proposedLevel,
            model: caseFile.model,
            investigated_at: caseFile.investigatedAt
          }
        ],
        'shop_id,trigger_message_id'
      );

      await supabaseUpdateById(supabase, 'tickets', ticket.id, {
        level,
        investigated_at: caseFile.investigatedAt,
        // Cleared last, so a crash above leaves the ticket to be retried rather
        // than marked done with no case file behind it.
        needs_investigation: false,
        metadata: mergeMetadata(ticket.metadata, {
          verdict: caseFile.verdict,
          attempts: 0,
          last_error: null,
          failed: null,
          at: caseFile.investigatedAt
        })
      });
    },

    async updateTicket(ticketId, patch) {
      await supabaseUpdateById(supabase, 'tickets', ticketId, patch);
    },

    /**
     * Raises the flag for tickets that are already categorised.
     *
     * Needed exactly twice in a system's life, and both times for the same
     * reason: the flag is only ever raised by the categoriser finishing, so a
     * ticket labelled BEFORE this pass existed will never enter the queue on its
     * own. That is true at rollout (565 tickets already categorised) and again
     * whenever a subject is added to ENABLED_SUBJECTS — its existing tickets
     * were skipped and their flag cleared.
     *
     * Deliberately not automatic: a pass that re-raises its own queue on startup
     * would re-investigate the whole backlog on every deploy.
     */
    async raiseForCategorised(shopId, { subjects = ENABLED_SUBJECTS, dryRun = false } = {}) {
      const filters = {
        shop_id: shopId,
        status: 'open',
        needs_categorisation: { operator: 'is', value: 'false' },
        needs_investigation: { operator: 'is', value: 'false' },
        category: { operator: 'in', value: `(${subjects.join(',')})` },
        deleted_at: { operator: 'is', value: 'null' },
        archived_at: { operator: 'is', value: 'null' }
      };
      const pending = await supabaseSelect(supabase, 'tickets', filters, 'id', { limit: 1000 });
      if (pending.length > 0 && !dryRun) {
        await supabaseUpdate(supabase, 'tickets', filters, { needs_investigation: true });
      }
      return pending.length;
    }
  };
}

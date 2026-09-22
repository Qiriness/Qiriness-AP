import {
  supabaseInsert,
  supabaseSelect,
  supabaseSelectAll,
  supabaseUpdate,
  supabaseUpdateById
} from './supabase-rest-client.mjs';
import { COLUMNS, T, V } from './tables.mjs';

/**
 * The ticket row, and the only module that writes it.
 *
 * WHY THIS EXISTS. `tickets` is the row the whole product turns on, and until
 * this module nothing owned it: eight modules each held a private store over the
 * same table, each naming its own columns and building its own patch, and one of
 * them (investigation-runner's backfill) wrote past its own store with a raw
 * `supabaseUpdate`. The queue protocol that sequences the passes —
 * `needs_categorisation` handed to `needs_investigation` — was spelled out in
 * five of them, and the rule that makes it crash-safe ("clear the flag LAST, in
 * the same patch") was a comment repeated beside each one rather than a thing the
 * code did once.
 *
 * WHAT IT OWNS
 *   · the needs_* flags and the order they move in
 *   · the `deleted_at` / `archived_at` filters every reader needs
 *   · the lifecycle timestamps (`closed_at`, `resolved_at`, `*_at` stamps)
 *   · the `metadata.<pass>` trail, merged and never replaced
 *   · the shop scope: bound once, at construction
 *
 * WHAT IT DOES NOT OWN
 *   · `ticket_messages` writes — ticket-writer keeps the upsert. This module
 *     READS that table (see `inboundMessages`), because "what did the customer
 *     say" is a question every pass asks of a ticket and was answered by two
 *     identical readers before. Reads and writes having different owners is
 *     unusual enough to say out loud: the rule is that a message arrives through
 *     ingestion and is read through here.
 *   · `ticket_investigations` — the case file is its own contract, in
 *     agent/src/investigation/case-file.mjs.
 *   · policy. `shouldAutoClose`, the level ratchet and the verdict mapping stay
 *     in their own modules and hand this one columns.
 *
 * WHY IT LIVES IN scripts/lib. `web/` reaches this directory through `allowJs`
 * and cannot import from `agent/src`. The dashboard's status write touches the
 * same three lifecycle columns auto-close does, so leaving it outside would have
 * kept two owners of exactly the columns this module exists to own — the same
 * reason support-taxonomy.mjs and customer-segments.mjs already live here.
 */

/**
 * The two passes that run off a flag.
 *
 * Both do the identical cycle — claim a batch, then complete / skip / retry /
 * abandon each ticket — so the cycle is written once and the differences are
 * data. Adding a third flagged pass is a descriptor, not another store.
 *
 *   flag     the column that puts a ticket in this pass's queue
 *   raises   the flag set in the SAME patch that clears `flag`, on success only
 *   stamp    when the pass last finished with this ticket
 *   trail    the `metadata` key holding attempts, errors and the reasoning
 *   columns  what the pass needs to read
 *   where    extra selection, beyond shop / not-deleted / not-archived
 */
export const PASSES = {
  categorisation: {
    flag: 'needs_categorisation',
    // The only writer of needs_investigation that follows a NEW MESSAGE.
    // Ingestion deliberately does not set it, so a thread is never investigated
    // against labels describing an older conversation (04_support.sql). Order
    // resolution also raises it when a late-confirmed order makes a case file
    // stale (reinvestigationColumns), a person linking an order on the dashboard
    // does (linkOrderManually), and `tickets:requeue` does by hand.
    raises: 'needs_investigation',
    stamp: 'categorised_at',
    trail: 'categorisation',
    columns: COLUMNS.ticketForCategorisation,
    where: { status: 'open' }
  },
  investigation: {
    flag: 'needs_investigation',
    raises: null,
    stamp: 'investigated_at',
    trail: 'investigation',
    columns: COLUMNS.ticketForInvestigation,
    // `needs_categorisation` must be false as well: a ticket whose labels are
    // still pending would be investigated with a tool set chosen from the
    // previous conversation's subject. Within a poll the categoriser runs first
    // and this cannot happen; the filter covers the cases it does not own — no
    // OpenAI key, a batch that did not drain, a flag set by hand.
    where: { status: 'open', needs_categorisation: false }
  }
};

const IS_NULL = { operator: 'is', value: 'null' };
const NOT_NULL = { operator: 'not.is', value: 'null' };
const IS_TRUE = { operator: 'is', value: 'true' };
const IS_FALSE = { operator: 'is', value: 'false' };

/** Oldest first: a support queue is served in arrival order. */
const OLDEST_FIRST = 'first_message_at.asc';

function passOrThrow(name) {
  const pass = PASSES[name];
  if (!pass) {
    throw new Error(`Unknown ticket pass: ${name}. Known passes: ${Object.keys(PASSES).join(', ')}`);
  }
  return pass;
}

/**
 * Merge one pass's trail into `metadata`, leaving every other key alone.
 *
 * One jsonb column is shared by the categoriser, the investigation and the
 * customer resolver, so this patches a key rather than replacing the object.
 * It was implemented twice, identically, before this module existed.
 */
function withTrail(metadata, key, entry) {
  const base = metadata && typeof metadata === 'object' ? metadata : {};
  return { ...base, [key]: { ...base[key], ...entry } };
}

/**
 * Consecutive failures in the CURRENT pending cycle.
 *
 * Reset by `complete`, not by time: a ticket that stumbled twice months ago gets
 * its full allowance again when a new reply puts it back in the queue.
 */
export function attemptsSoFar(metadata, passName) {
  const attempts = metadata?.[passOrThrow(passName).trail]?.attempts;
  return Number.isInteger(attempts) ? attempts : 0;
}

/**
 * The lifecycle columns for a status change.
 *
 * `closed_at` and `resolved_at` are what retention reads, so they move with the
 * status rather than being left to drift — and moving OFF a terminal status
 * clears both, or a reopened ticket still reads as finished to anything looking
 * at the timestamps rather than at the status.
 */
function lifecycleColumns(status, at) {
  if (status === 'closed') return { status, closed_at: at };
  if (status === 'resolved') return { status, resolved_at: at };
  return { status, closed_at: null, resolved_at: null };
}

/**
 * The PostgREST calls this module makes, as one object.
 *
 * Injectable so the tests can substitute an in-memory transport and assert the
 * PATCH bodies directly — which is the whole point of putting the ticket rules
 * behind one interface. Two adapters justify the seam: this one in every
 * runtime, a recording one in ticket-record.test.mjs.
 */
export const REST_TRANSPORT = {
  select: supabaseSelect,
  selectAll: supabaseSelectAll,
  insert: supabaseInsert,
  update: supabaseUpdate,
  updateById: supabaseUpdateById
};

export function createTicketRecord(supabase, { shopId, transport = REST_TRANSPORT }) {
  if (!shopId) {
    throw new Error('createTicketRecord requires a shopId: every read and write here is shop-scoped.');
  }

  const { select, selectAll, insert, update, updateById } = transport;

  /** Every read starts here. A soft-deleted ticket is invisible to all of them. */
  const live = (extra = {}) => ({ shop_id: shopId, deleted_at: IS_NULL, ...extra });

  const patch = (ticketId, columns) => updateById(supabase, T.TICKETS, ticketId, columns);

  /**
   * One queue row, same shape as the list.
   *
   * A local function rather than only a method, so `setStatus` can call it
   * without going through `this` — a caller that destructures the record would
   * otherwise get an unbound method and a TypeError on the first close.
   */
  const queueRow = async (ticketId) => {
    const rows = await select(
      supabase,
      V.TICKET_QUEUE,
      { id: ticketId, shop_id: shopId },
      COLUMNS.ticketQueue,
      { limit: 1 }
    );
    return rows[0] || null;
  };

  return {
    // ======================================================================
    // The pass protocol
    // ======================================================================

    /**
     * The batch this pass should work on, oldest first.
     *
     * Selects on ticket STATE rather than on what the current poll wrote, so
     * anything missed is caught up next time and a single pass never has to be
     * complete.
     *
     * `anyStatus` DROPS THE STATUS NARROWING AND NOTHING ELSE — an operator
     * asking for a deliberate re-run over threads the queue has moved past. It
     * exists because the default (`status: 'open'`) is right for the worker and
     * wrong for a backfill: auto-close retires a thread after 28 days of silence
     * without clearing its pending flag, so on an imported historical corpus the
     * work is all sitting behind a status filter. The flag, the categorisation
     * requirement, `archived_at` and the soft-delete still apply, so this widens
     * the queue rather than opening it.
     *
     * NEVER DEFAULTED ON, and no pass descriptor can set it: a worker that
     * quietly spent the mid tier on closed mail nobody is waiting for would be a
     * bill with no one asking for it. It is a per-call argument, and the only
     * caller that passes it is a CLI flag a person typed.
     */
    /**
     * Links a ticket to the one it duplicates.
     *
     * WRITTEN HERE because `tickets` has one writer, and this is a ticket
     * column like any other. The DECISION is not this module's — the rules live
     * in `agent/src/ingestion/duplicate-rules.mjs` and are deterministic; this
     * records what they concluded.
     *
     * The three columns move together, which the check constraint also enforces:
     * a link with no reason is unreviewable, and the reason is the first thing a
     * person needs before undoing it.
     */
    async linkDuplicate(ticketId, { ofTicketId, reason, at = new Date().toISOString() }) {
      if (!ofTicketId || !reason) {
        throw new Error('linkDuplicate requires both the ticket it duplicates and the reason.');
      }
      if (ofTicketId === ticketId) {
        throw new Error('A ticket cannot be a duplicate of itself.');
      }
      return patch(ticketId, {
        duplicate_of_ticket_id: ofTicketId,
        duplicate_reason: reason,
        duplicate_detected_at: at
      });
    },

    /**
     * Links a ticket to an earlier one it CONTINUES — a chase, or a thread that
     * split across conversation ids.
     *
     * DELIBERATELY NOT `linkDuplicate` WITH A FLAG. The two links look alike and
     * mean opposite things: a duplicate is answered with silence, a related
     * ticket is answered with a reply that opens by apologising. Sharing one
     * writer would make the difference a parameter, and a parameter is exactly
     * what gets passed wrong.
     *
     * The score travels because the threshold will move, and a link recorded
     * under the old one has to stay interpretable.
     */
    /**
     * Records that one of our own addresses opened this thread.
     *
     * Set once, at ticket creation, and written here only by the backfill for
     * mail that predates the column. There is no "unset" path on purpose: a
     * thread does not stop having been started by a colleague, and a label
     * cleared by mistake would quietly put a colleague's mail back in the
     * customer drafting queue.
     */
    async setSenderLabel(ticketId, label) {
      if (!label) {
        throw new Error('setSenderLabel requires a label; null is the absence of one, not a value to write.');
      }
      return patch(ticketId, { sender_label: label });
    },

    async linkRelated(ticketId, { toTicketId, score, at = new Date().toISOString() }) {
      if (!toTicketId || typeof score !== 'number' || Number.isNaN(score)) {
        throw new Error('linkRelated requires the earlier ticket and the score that matched it.');
      }
      if (toTicketId === ticketId) {
        throw new Error('A ticket cannot be related to itself.');
      }
      return patch(ticketId, {
        related_ticket_id: toTicketId,
        related_score: score,
        related_detected_at: at
      });
    },

    /**
     * Removes a related link that the evidence no longer supports.
     *
     * THERE IS AN UNLINK HERE AND DELIBERATELY NOT ONE FOR THE OTHER TWO.
     * `sender_label` records who wrote, which does not stop being true; a
     * duplicate link suppresses a reply and may already have been reviewed by a
     * person, so it is theirs to clear. A related link is neither — it is
     * derived context, re-derivable from the same rule, and a link resting on a
     * message body that has since been corrected is simply wrong. Six of nine
     * were exactly that after the contact-form repair.
     */
    /**
     * Corrects a ticket's requester.
     *
     * NOT PART OF INGESTION, and there is no caller in the pipeline. The
     * write-once rule stands: a requester that changed while somebody was
     * reading the queue would be worse than one that is occasionally stale.
     * This exists for the reconcile tool, which decides — narrowly, and only
     * when the stored identity is provably one of ours — that a row is wrong.
     *
     * The two columns move together because they describe one person: a name
     * updated without its hash would show the right person and join to the
     * wrong one's orders.
     */
    async setRequester(ticketId, { name, emailHash }) {
      if (!emailHash) {
        throw new Error('setRequester requires the hash; a name without one would break order matching.');
      }
      return patch(ticketId, { requester_name: name ?? null, requester_email_hash: emailHash });
    },

    /**
     * Forgets which customer a ticket belongs to.
     *
     * The other half of `setRequester`, and for the same reconcile tool only.
     * `customer_id` is otherwise never cleared, so a ticket linked from a wrong
     * requester — measured 2026-09-14: two tickets linked from a colleague's
     * address after a newest-first ingestion — kept that customer for ever,
     * because customer resolution only looks at unlinked tickets. The
     * `customer_resolution` trail is left alone: it names the hash the old link
     * was made against, which is exactly what lets the next pass retry.
     */
    async unlinkCustomer(ticketId) {
      return patch(ticketId, { customer_id: null });
    },

    async clearRelated(ticketId) {
      return patch(ticketId, {
        related_ticket_id: null,
        related_score: null,
        related_detected_at: null
      });
    },

    async claim(passName, { limit, anyStatus = false, ticketId = null } = {}) {
      const pass = passOrThrow(passName);
      const flags = { [pass.flag]: IS_TRUE };
      for (const [column, value] of Object.entries(pass.where)) {
        if (anyStatus && column === 'status') {
          continue;
        }
        flags[column] = typeof value === 'boolean' ? (value ? IS_TRUE : IS_FALSE) : value;
      }
      // NARROWS, NEVER WIDENS. `ticketId` adds a filter to the queue rather than
      // bypassing it: the pass's flag and its `where` still apply, so naming a
      // ticket that is not due this pass returns nothing rather than running it
      // anyway. That is what keeps it an operator convenience — "look at this
      // one" — instead of a second, unguarded way into the pass.
      //
      // It exists because the queue is oldest-first over a historical corpus:
      // 109 imported tickets carry a flag no poll can reach, so re-running one
      // recent ticket by hand meant running everything before it.
      if (ticketId) {
        flags.id = ticketId;
      }
      return select(
        supabase,
        T.TICKETS,
        live({ ...flags, archived_at: IS_NULL }),
        pass.columns,
        { order: OLDEST_FIRST, limit }
      );
    },

    /**
     * The pass finished with this ticket.
     *
     * THE ORDER INSIDE THE PATCH IS THE POINT. The flag is cleared and the next
     * one raised in the SAME write as the result, so a crash anywhere before
     * this leaves the ticket in the queue to be retried rather than marked done
     * with nothing behind it. The trail's failure counters reset here: the
     * ticket succeeded, and the next failure starts from zero.
     */
    async complete(passName, ticket, { columns = {}, trail = {}, at = new Date().toISOString() } = {}) {
      const pass = passOrThrow(passName);
      return patch(ticket.id, {
        ...columns,
        [pass.stamp]: at,
        [pass.flag]: false,
        ...(pass.raises ? { [pass.raises]: true } : {}),
        metadata: withTrail(ticket.metadata, pass.trail, {
          ...trail,
          attempts: 0,
          last_error: null,
          failed: null,
          at
        })
      });
    },

    /**
     * Nothing for this pass to do, and that is not a failure.
     *
     * Clears the flag and writes nothing else — no stamp, no trail. Safe
     * precisely because it is not permanent: ingestion re-raises
     * `needs_categorisation` the moment an inbound message joins the thread,
     * which is the only event that makes such a ticket workable. Leaving the
     * flag up instead parks the ticket at the front of an oldest-first batch for
     * good — measured at 11 of every 25 slots on every poll, accumulating.
     */
    async skip(passName, ticketId) {
      return patch(ticketId, { [passOrThrow(passName).flag]: false });
    },

    /** Failed, but retryable: record the attempt and leave the ticket queued. */
    async retry(passName, ticket, { attempts, error, at = new Date().toISOString() }) {
      const pass = passOrThrow(passName);
      return patch(ticket.id, {
        metadata: withTrail(ticket.metadata, pass.trail, {
          attempts,
          last_error: error?.message ?? String(error),
          at
        })
      });
    },

    /**
     * Out of retries. Clear the flag anyway.
     *
     * A permanently failing ticket must not occupy a batch slot on every poll
     * forever. What it becomes is the caller's to decide — `columns` carries the
     * fallback labels or the low-confidence marker — but it is always VISIBLE:
     * the trail says it was not actually judged, so a fallback is never read as
     * a verdict.
     *
     * Never raises the next flag. Investigating a guess would spend tool and
     * model calls on a subject nobody chose.
     */
    async abandon(passName, ticket, { columns = {}, trail = {}, attempts, error, at = new Date().toISOString() }) {
      const pass = passOrThrow(passName);
      return patch(ticket.id, {
        ...columns,
        [pass.stamp]: at,
        [pass.flag]: false,
        metadata: withTrail(ticket.metadata, pass.trail, {
          ...trail,
          attempts,
          failed: true,
          last_error: error?.message ?? String(error),
          at
        })
      });
    },

    /**
     * Put already-finished tickets back in a pass's queue.
     *
     * Needed exactly twice in a system's life, and both times for the same
     * reason: a flag is only ever raised by the previous pass finishing, so a
     * ticket processed BEFORE a pass existed will never enter its queue on its
     * own. That is true at rollout and again whenever a subject joins
     * ENABLED_SUBJECTS.
     *
     * Deliberately not automatic: a pass that re-raised its own queue on startup
     * would redo the whole backlog on every deploy.
     */
    async raiseFor(passName, { where = {}, limit = 1000, dryRun = false } = {}) {
      const pass = passOrThrow(passName);
      const filters = live({
        ...where,
        status: 'open',
        needs_categorisation: IS_FALSE,
        [pass.flag]: IS_FALSE,
        archived_at: IS_NULL
      });
      const pending = await select(supabase, T.TICKETS, filters, 'id', { limit });
      if (pending.length > 0 && !dryRun) {
        await update(supabase, T.TICKETS, filters, { [pass.flag]: true });
      }
      return pending.length;
    },

    // ======================================================================
    // Writes with no flag behind them
    // ======================================================================

    /** A conversation we have not seen before. */
    async create(row) {
      const rows = await insert(supabase, T.TICKETS, [{ ...row, shop_id: shopId }]);
      return rows[0];
    },

    /**
     * A message joined the thread.
     *
     * The caller decides what the message means for the timestamps and the
     * requester — that reasoning is ingestion's and stays in ticket-writer. What
     * belongs here is that the resulting patch is one write, and that an empty
     * one is not sent at all.
     */
    async recordMessageArrival(ticketId, columns) {
      if (!columns || Object.keys(columns).length === 0) {
        return null;
      }
      return patch(ticketId, columns);
    },

    /**
     * Which customer wrote this, and always the reasoning.
     *
     * `customer_id` moves only on a match; the trail is written either way, so an
     * unlinked ticket is explained rather than merely empty and the next pass can
     * see what was already tried against which address.
     */
    async linkCustomer(ticket, { customerId, status, matchedBy, emailHash, attemptedAt }) {
      return patch(ticket.id, {
        ...(customerId ? { customer_id: customerId } : {}),
        metadata: withTrail(ticket.metadata, 'customer_resolution', {
          status,
          matched_by: matchedBy,
          // The hash the attempt was made against. A ticket's requester can be
          // backfilled after the fact, and an attempt against the old identity
          // says nothing about the new one.
          email_hash: emailHash,
          attempted_at: attemptedAt
        })
      });
    },

    /** A confirmed order number, plus whatever the resolver concluded. */
    async linkOrder(ticketId, columns) {
      return patch(ticketId, columns);
    },

    /**
     * The order bundle, and when it was built.
     *
     * `customer_id` is linked at the same time where the ticket had none: it knew
     * a hash before and now knows which customer row that was, which is what lets
     * every later tool skip the resolution step.
     */
    async setResolvedContext(ticket, context, customerId) {
      return patch(ticket.id, {
        resolved_context: context,
        context_resolved_at: new Date().toISOString(),
        ...(customerId && !ticket.customer_id ? { customer_id: customerId } : {})
      });
    },

    /**
     * Auto-close. Stamped so an automatic close is distinguishable from one a
     * person made — otherwise the queue's history cannot explain itself.
     *
     * `closed_reason` is a TOP-LEVEL metadata key, not a pass trail: it describes
     * the ticket, not a pass's working notes.
     */
    async close(ticket, now = new Date()) {
      const at = now.toISOString();
      return patch(ticket.id, {
        ...lifecycleColumns('closed', at),
        updated_at: at,
        metadata: { ...(ticket.metadata || {}), closed_reason: 'inactivity' }
      });
    },

    /**
     * The dashboard moving a ticket between the queue and the closed section.
     *
     * Scoped by shop as well as id: an id alone would let one shop's request
     * touch another's row. Returns the queue row rather than the update's own
     * representation — the row this returns replaces the one on screen, and
     * reading it back from `ticket_queue` is what guarantees it is exactly the
     * shape the list renders, embed and message count included.
     */
    /**
     * A person linked, changed or confirmed this ticket's order.
     *
     * CONDITIONAL ON THE ORDER THEY SAW. The filter carries the number the
     * dashboard showed, so a change made meanwhile — another person, or the
     * worker confirming one — makes this match nothing and return null rather
     * than overwrite it. `columns` come from `manualOrderColumns`; a reopen
     * carries the lifecycle columns a status change always carries.
     */
    async linkOrderManually(ticketId, { expectedOrderNumber = null, columns }) {
      const at = new Date().toISOString();
      const updated = await update(
        supabase,
        T.TICKETS,
        live({
          id: ticketId,
          shopify_order_number: expectedOrderNumber === null ? IS_NULL : expectedOrderNumber
        }),
        {
          ...columns,
          ...(columns.status ? lifecycleColumns(columns.status, at) : {}),
          updated_at: at
        },
        { select: 'id' }
      );
      const row = Array.isArray(updated) ? updated[0] : updated;
      return row ? queueRow(ticketId) : null;
    },

    async setStatus(ticketId, status) {
      const at = new Date().toISOString();
      const updated = await update(
        supabase,
        T.TICKETS,
        { id: ticketId, shop_id: shopId },
        { ...lifecycleColumns(status, at), updated_at: at },
        { select: 'id' }
      );
      const row = Array.isArray(updated) ? updated[0] : updated;
      if (!row) {
        return null;
      }
      return queueRow(ticketId);
    },

    // ======================================================================
    // Reads
    // ======================================================================

    /** The thread this conversation id already has, or null. */
    async findByConversation(conversationId) {
      const rows = await select(
        supabase,
        T.TICKETS,
        { shop_id: shopId, graph_conversation_id: conversationId },
        COLUMNS.ticketForConversation
      );
      return rows[0] || null;
    },

    /** Tickets that know an address but not which customer it is. */
    async findUnlinkedCustomers({ limit = 500 } = {}) {
      return selectAll(
        supabase,
        T.TICKETS,
        live({ customer_id: IS_NULL, requester_email_hash: NOT_NULL }),
        COLUMNS.ticketForCustomerResolution,
        { limit }
      );
    },

    /** Tickets with no order number yet. */
    async findAwaitingOrderNumber({ limit = 500 } = {}) {
      return selectAll(
        supabase,
        T.TICKETS,
        live({ shopify_order_number: IS_NULL }),
        COLUMNS.ticketForOrderResolution,
        { limit }
      );
    },

    /**
     * Tickets with a confirmed order number but no bundle yet. `refresh` widens
     * it to every ticket with an order number, for rebuilding after a sync moved
     * the orders underneath.
     */
    async findAwaitingContext({ refresh = false, limit = 500 } = {}) {
      return selectAll(
        supabase,
        T.TICKETS,
        live({
          shopify_order_number: NOT_NULL,
          ...(refresh ? {} : { context_resolved_at: IS_NULL })
        }),
        COLUMNS.ticketForOrderContext,
        { limit }
      );
    },

    /**
     * Tickets nobody has touched since `cutoff`.
     *
     * The status and date narrowing happens here and the level exemption in
     * `shouldAutoClose`: PostgREST's `not.eq` on a nullable column drops the NULL
     * rows too, which would silently spare every uncategorised ticket — the
     * largest group of all.
     */
    async findInactive(cutoff) {
      return selectAll(
        supabase,
        T.TICKETS,
        live({
          status: { operator: 'not.in', value: '(resolved,closed)' },
          last_message_at: { operator: 'lt', value: cutoff.toISOString() }
        }),
        COLUMNS.ticketForAutoClose
      );
    },

    /**
     * The dashboard queue: every live ticket with its customer and message count
     * already joined, from the `ticket_queue` view.
     *
     * Soft-deleted rows are excluded by the view, not by this filter — a
     * compliance delete must not reach the UI even through a reader that forgot.
     */
    async queue() {
      return selectAll(supabase, V.TICKET_QUEUE, { shop_id: shopId }, COLUMNS.ticketQueue);
    },

    queueRow,

    /** What a person linking an order reads before the change. */
    async findForOrderLink(ticketId) {
      const rows = await select(
        supabase,
        T.TICKETS,
        live({ id: ticketId }),
        COLUMNS.ticketForOrderLink,
        { limit: 1 }
      );
      return rows[0] || null;
    },

    /** What the detail panel reads off the ticket itself. */
    async findForDetail(ticketId) {
      const rows = await select(
        supabase,
        T.TICKETS,
        live({ id: ticketId }),
        COLUMNS.ticketForDetail,
        { limit: 1 }
      );
      return rows[0] || null;
    },

    /** Subject only — enough to 404 a ticket that is not this shop's. */
    /**
     * What the thread dialog needs off the ticket itself.
     *
     * The duplicate link travels because the dialog is where a person decides
     * what to do with a DRAFT, and a draft on a ticket linked as a duplicate is
     * one that must not be sent. Learning that after reading it is too late.
     *
     * `resolved_context` travels for the parcels inside it, and nothing else the
     * bundle holds is read here: a tracking number in a message body or in the
     * draft is rendered as a link to the carrier, and the URL only exists on
     * this column. Without it the dialog would have the numbers and no way to
     * know which of them we actually hold a link for — and guessing is what
     * `splitTrackingText` refuses to do.
     */
    async findForThread(ticketId) {
      const rows = await select(
        supabase,
        T.TICKETS,
        live({ id: ticketId }),
        'id,subject,duplicate_of_ticket_id,duplicate_reason,related_ticket_id,related_score,resolved_context',
        { limit: 1 }
      );
      return rows[0] || null;
    },

    // ---------------------------------------------------------------- messages
    //
    // READ ONLY. ticket-writer owns the upsert; these are the questions the
    // passes ask of a thread, and they were two identical readers before.

    /**
     * The customer's own messages, oldest first, already stripped of quoted
     * reply chains upstream.
     *
     * `columns` is the caller's, because what a reader needs off a message
     * differs sharply: the categoriser wants the words, the investigation also
     * wants the sender and the stored embedding, and the difference is worth
     * more than a shared projection that ships 1536 floats to whoever asks.
     */
    async inboundMessages(ticketId, { limit, columns = COLUMNS.messageForCategorisation } = {}) {
      return select(
        supabase,
        T.TICKET_MESSAGES,
        { ticket_id: ticketId, direction: 'inbound', deleted_at: IS_NULL },
        columns,
        { order: 'received_at.asc', limit }
      );
    },

    /**
     * The conversation a pass reasons over: both directions, oldest first.
     *
     * Separate from `inboundMessages` rather than a flag on it, because the two
     * answer different questions and the older one is still right for its own.
     * The categoriser labels what the customer asked; the situation matcher
     * scores the request that opened the thread. Neither wants our replies in
     * its query, and both were calibrated without them. The investigation does
     * want them — a reply saying « oui, c'est fait » is unreadable without the
     * question it answers.
     *
     * `received_at` is populated on BOTH directions (verified 2026-09-21: 329 of
     * 329 rows), so one ordering interleaves the thread correctly and the reader
     * does not have to coalesce two clocks.
     *
     * THE CAP IS APPLIED AFTER THE READ, and that is deliberate. Pushed into the
     * query it would have to invert the ordering to keep the newest messages —
     * a cap on an ascending read drops the most recent, which on a long thread
     * is precisely the part the pass was woken up for — and the reader would
     * then depend on the transport honouring `order` to be correct at all. The
     * longest thread in the corpus is 9 messages against a cap of 10, so the
     * saving was never real and the fragility would have been.
     */
    async conversation(ticketId, { limit, columns = COLUMNS.threadForInvestigation } = {}) {
      const rows = await select(
        supabase,
        T.TICKET_MESSAGES,
        { ticket_id: ticketId, shop_id: shopId, deleted_at: IS_NULL },
        columns,
        { order: 'received_at.asc' }
      );
      return limit && rows.length > limit ? rows.slice(-limit) : rows;
    },

    /**
     * The opening inbound message of every ticket, from `ticket_first_inbound`.
     *
     * Quoted history is where stale order numbers from previous threads live, so
     * order resolution reads the first message and not the thread. The view does
     * the per-ticket pick in Postgres; this used to read every inbound body in
     * the shop and keep one per ticket in a Map.
     */
    async firstInboundByTicket() {
      const rows = await selectAll(
        supabase,
        V.TICKET_FIRST_INBOUND,
        { shop_id: shopId },
        'ticket_id,subject,body_text',
        { order: 'ticket_id.asc' }
      );
      return new Map(rows.map((row) => [row.ticket_id, `${row.subject || ''}\n${row.body_text || ''}`]));
    },

    /** The whole conversation, both directions — what the thread dialog shows. */
    async thread(ticketId) {
      return selectAll(
        supabase,
        T.TICKET_MESSAGES,
        { ticket_id: ticketId, shop_id: shopId, deleted_at: IS_NULL },
        COLUMNS.messageForThread
      );
    }
  };
}

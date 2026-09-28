import { sendDedupeKey } from '../../../scripts/lib/mail-job-record.mjs';
import { actionFromDraft } from '../../../scripts/lib/outbound-record.mjs';
import { preSendCheck } from './outbound-rules.mjs';

/**
 * THE OUTBOUND WORKER: the only code that calls a provider's
 * `createReplyDraft` or `sendDraft`. (Forwarding a message to a colleague is
 * the one other path that sends mail, routing/forward-runner.mjs, and it never
 * addresses a customer.)
 *
 * Two passes, placed apart in the poll on purpose:
 *
 *   confirmSentActions  right after ingestion. A reply we sent comes back
 *                       through the Sent Items delta; the matching action
 *                       becomes sent_confirmed and its draft `sent`. It runs
 *                       BEFORE the fold so the fold does not first mark that
 *                       draft superseded by our own reply.
 *
 *   runOutbound         after the fold, so the pre-send check reads a case
 *                       version and a thread that include everything the poll
 *                       just ingested.
 *
 * A SEND IS NEVER RETRIED BLIND. `send_requested` is written before the call,
 * so any action in it may already have gone. Before doing anything more with
 * such an action the worker asks the mailbox whether the draft is still a
 * draft (`findSentMessage`).
 */

/**
 * Match actions that may have sent against what ingestion stored.
 */
export async function confirmSentActions({ outboundRecord, draftRecord, store, logger, shopId }) {
  const totals = { considered: 0, confirmed: 0 };
  const pending = await outboundRecord.awaitingConfirmation();
  for (const action of pending) {
    if (!action.provider_draft_id && !action.provider_internet_message_id) continue;
    totals.considered += 1;
    const stored = await store.storedSentMessage({
      providerDraftId: action.provider_draft_id,
      internetMessageId: action.provider_internet_message_id
    });
    if (!stored) continue;
    if (await outboundRecord.markConfirmed(action.id, { sentMessageId: stored.id })) {
      totals.confirmed += 1;
      await draftRecord.markSent(action.draft_id);
      logger?.info?.('outbound.sent_confirmed', { shopId, actionId: action.id, ticketId: action.ticket_id });
    }
  }
  return totals;
}

/**
 * AUTO_SEND: the drafts the level gate would send by itself become actions.
 * Does nothing while DRAFT_ONLY is on (the default) or sending is disabled.
 * A draft that already has an action, whatever became of it, is not offered
 * again: one action per draft, and the key would refuse a second anyway.
 */
export async function createAutoSendActions({ store, outboundRecord, jobs, draftOnly = true, enabled = false, limit = 10, logger, shopId }) {
  const totals = { considered: 0, created: 0 };
  if (draftOnly || !enabled) return totals;

  const candidates = await store.autoSendCandidates();
  const taken = await store.draftsWithActions(candidates.map((draft) => draft.id));
  for (const draft of candidates.filter((d) => !taken.has(d.id)).slice(0, limit)) {
    totals.considered += 1;
    const built = actionFromDraft(draft, { mode: 'auto_send', requestedBy: 'agent' });
    if (built.error) continue;
    const { created, action } = await outboundRecord.create(built.row);
    if (!created || !action) continue;
    await jobs.enqueue({ kind: 'send_outbound', dedupeKey: sendDedupeKey(action.id), payload: { outboundActionId: action.id } });
    totals.created += 1;
    logger?.info?.('outbound.auto_send_queued', { shopId, actionId: action.id, ticketId: action.ticket_id });
  }
  return totals;
}

/**
 * Claim due `send_outbound` jobs and carry each action as far as it may go.
 *
 * `enabled` is OUTBOUND_SEND_ENABLED: when false nothing is claimed, and the
 * jobs wait untouched for the switch.
 *
 * `stopBeforeSend` is OUTBOUND_STOP_BEFORE_SEND: every check runs and the
 * reply draft is created, then the action is left at `draft_created` for a
 * person to send from Outlook. `sendDraft` is never called.
 */
export async function runOutbound({
  jobs,
  outboundRecord,
  draftRecord,
  store,
  provider,
  enabled = false,
  stopBeforeSend = false,
  draftOnly = true,
  maxAttempts,
  leaseSeconds = 300,
  limit = 10,
  logger,
  shopId
}) {
  const totals = { considered: 0, sent: 0, held: 0, cancelled: 0, failed: 0, awaitingConfirmation: 0, closed: 0, retried: 0, dead: 0 };
  if (!enabled) return totals;

  const claimed = await jobs.claim({ kinds: ['send_outbound'], limit, leaseSeconds });
  for (const job of claimed) {
    totals.considered += 1;
    const actionId = job.payload?.outboundActionId ?? null;
    try {
      if (maxAttempts && job.retry_count >= maxAttempts) {
        throw new Error('the worker died holding this job too many times');
      }
      const outcome = await carryOut(actionId);
      totals[outcome] = (totals[outcome] ?? 0) + 1;
      await jobs.complete(job.id);
    } catch (error) {
      const patch = await jobs.fail(job, error, { maxAttempts });
      if (patch.state === 'dead') {
        totals.dead += 1;
        if (actionId) await outboundRecord.markFailed(actionId, `retries exhausted: ${patch.last_error}`);
        logger?.error?.('outbound.dead', { shopId, actionId, jobId: job.id, error: patch.last_error });
      } else {
        totals.retried += 1;
        logger?.warn?.('outbound.retry', { shopId, actionId, jobId: job.id, attempt: patch.retry_count, error: patch.last_error });
      }
    }
  }
  return totals;

  /** One action, from whatever state it is in. Returns the outcome to count. */
  async function carryOut(id) {
    const action = id ? await outboundRecord.get(id) : null;
    if (!action) return 'closed';

    switch (action.state) {
      case 'approved':
        return fromApproved(action);
      case 'draft_created':
      case 'send_requested':
        return fromDraft(action);
      default:
        // sent_confirmed, cancelled, failed: nothing left to do.
        return 'closed';
    }
  }

  async function fromApproved(action) {
    const facts = await gatherFacts(action);
    const verdict = preSendCheck({ action, ...facts, draftOnly });
    if (!verdict.ok) return cancel(action, verdict.reason);

    const { replyTo } = facts;
    if (!replyTo?.graph_message_id) return fail(action, 'reply_target_missing');
    if (!replyTo.from_email) return fail(action, 'no_recipient');

    const draft = await provider.createReplyDraft(replyTo.graph_message_id, {
      bodyText: action.body_text,
      to: [replyTo.from_email]
    });
    // Another holder moved the row meanwhile: its draft is the one that
    // counts, and this one stays unsent in the Drafts folder.
    const recorded = await outboundRecord.markDraftCreated(action.id, {
      providerDraftId: draft.draftId,
      internetMessageId: draft.internetMessageId
    });
    if (!recorded) return 'closed';
    return send(action, draft.draftId);
  }

  /** A draft exists at the provider: ask it where that draft is before anything else. */
  async function fromDraft(action) {
    if (!action.provider_draft_id) return fail(action, 'draft_id_missing');
    const where = await provider.findSentMessage({ draftId: action.provider_draft_id });
    if (where === 'sent') {
      // It went. Ingestion reads it back from Sent Items and confirms it.
      return 'awaitingConfirmation';
    }
    if (where === 'missing') return fail(action, 'draft_missing');

    // Still a draft, so nothing has gone: check again, as time has passed.
    const facts = await gatherFacts(action);
    const verdict = preSendCheck({ action, ...facts, draftOnly });
    if (!verdict.ok) return cancel(action, verdict.reason, { confirmedUnsent: true });
    return send(action, action.provider_draft_id);
  }

  async function send(action, draftId) {
    if (stopBeforeSend) {
      logger?.info?.('outbound.held_in_drafts', { shopId, actionId: action.id, ticketId: action.ticket_id });
      return 'held';
    }
    // Written BEFORE the call: a crash between the two leaves "maybe sent".
    if (!(await outboundRecord.markSendRequested(action.id))) return 'closed';
    await provider.sendDraft(draftId);
    logger?.info?.('outbound.send_requested', { shopId, actionId: action.id, ticketId: action.ticket_id, mode: action.mode });
    return 'sent';
  }

  async function cancel(action, reason, options) {
    await outboundRecord.cancel(action.id, reason, options);
    logger?.info?.('outbound.cancelled', { shopId, actionId: action.id, ticketId: action.ticket_id, reason });
    return 'cancelled';
  }

  async function fail(action, reason) {
    await outboundRecord.markFailed(action.id, reason);
    logger?.warn?.('outbound.failed', { shopId, actionId: action.id, ticketId: action.ticket_id, reason });
    return 'failed';
  }

  async function gatherFacts(action) {
    const [draft, caseCurrent, replyTo, otherActions] = await Promise.all([
      store.draft(action.draft_id),
      store.caseCurrent(action.ticket_id),
      store.message(action.reply_to_message_id),
      outboundRecord.forTicket(action.ticket_id)
    ]);
    const laterMessages = replyTo ? await store.messagesAfter(action.ticket_id, replyTo.received_at) : [];
    return { draft, caseCurrent, replyTo, laterMessages, otherActions };
  }
}

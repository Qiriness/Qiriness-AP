import {
  buildForwardNote,
  isReadyToForward,
  isTransientGraphError,
  MAX_ACK_ATTEMPTS,
  planAcknowledgement,
  shouldForwardMessage
} from './forward-rules.mjs';
import { planRoute } from './destination-router.mjs';
import { ackLanguage, isActive, renderAcknowledgement } from '../../../scripts/lib/forwarding-destinations.mjs';

// The forwarding pass: hand mail the contact team does not own to the
// destination that does, and tell the sender it went. Runs after categorisation,
// because the route starts from the category.
//
// OFF UNTIL SWITCHED ON. `forwarding_settings.forward_since` null forwards
// nothing, and once set only mail received from then on is considered, so the
// first run cannot send the backlog. Each destination has the same kind of
// switch (`active_since`): it receives only mail received after it was turned
// on, so turning one back on never delivers what arrived while it was off.
//
// ONE FAILURE DOES NOT STOP THE PASS. Each message is sent and recorded on its
// own; a Graph rejection on one becomes a `failed` row and the loop continues.
// A router error leaves that ticket undecided until the next poll.

const emptyTotals = () => ({
  considered: 0,
  forwarded: 0,
  failed: 0,
  skipped: 0,
  kept: 0,
  waiting: 0,
  undecided: 0,
  acknowledged: 0,
  ackSkipped: 0,
  ackFailed: 0
});

export async function runForwarding({
  store,
  graphClient,
  // The mail provider, for the acknowledgement: the same reply-draft-and-send
  // path the outbound worker uses, so it threads under the customer's message.
  provider = null,
  // `createDestinationChooser(...)`; without it a category with a choice is
  // left undecided rather than guessed.
  chooser = null,
  senderDirectory = null,
  shopId,
  logger,
  internalDomains = [],
  // Rehearsal: decide everything (the router included), send nothing, record
  // nothing.
  dryRun = false,
  // Dry runs only: rehearse as if forwarding had been switched on at this
  // instant. Refused on a real run, so it can never send the backlog.
  rehearseSince = null,
  onPreview
} = {}) {
  if (rehearseSince && !dryRun) {
    throw new Error('rehearseSince is for dry runs only.');
  }
  const totals = emptyTotals();
  const { destinations, settings, shopName } = await store.loadConfig(shopId);
  const since = rehearseSince ?? settings?.forward_since;
  if (!since) return totals;

  const active = destinations.filter(isActive);
  const categories = [...new Set(active.flatMap((d) => d.categories ?? []))];
  if (categories.length === 0) return totals;

  const pending = await store.findPending(shopId, { since, categories });

  for (const item of pending) {
    const count = item.messages.length;
    totals.considered += count;

    let decision;
    try {
      decision = await decide(item);
    } catch (error) {
      totals.undecided += count;
      logger?.warn?.('forward.route_failed', { ticketId: item.ticket.id, reason: error.message });
      continue;
    }
    if (!decision) {
      totals.undecided += count;
      continue;
    }
    if (decision.outcome !== 'forward') {
      totals.kept += count;
      continue;
    }

    // The decision names a destination; what it is NOW decides where mail goes.
    // One switched off or deleted since routes nothing.
    const destination = active.find((d) => d.id === decision.destination_id);
    if (!destination) {
      totals.skipped += count;
      continue;
    }
    if (!isReadyToForward({ destination, hasOutbound: item.hasOutbound })) {
      totals.waiting += count;
      continue;
    }

    let firstSent = null;
    for (const message of item.messages) {
      // Arrived while this destination was off: it stays with the contact team,
      // as it would have had the pass run then.
      // A rehearsal treats every destination on now as on since the rehearsal date.
      const start = rehearseSince ?? destination.active_since;
      if (message.receivedAt && Date.parse(message.receivedAt) < Date.parse(start)) {
        totals.skipped += 1;
        continue;
      }
      if (!shouldForwardMessage({ fromEmail: message.fromEmail, internalDomains })) {
        totals.skipped += 1;
        continue;
      }
      // A message ingested before the Graph id was stored cannot be forwarded by
      // reference, and re-composing it would lose the attachments that are often
      // the entire point (a CV, a PO). Skipped rather than faked.
      if (!message.graphMessageId) {
        totals.skipped += 1;
        logger?.warn?.('forward.no_graph_id', { ticketId: item.ticket.id });
        continue;
      }

      const comment = buildForwardNote({
        category: item.ticket.category,
        subject: message.subject || item.ticket.subject,
        afterReply: destination.timing === 'after_first_reply'
      });

      if (dryRun) {
        totals.forwarded += 1;
        firstSent ??= message;
        onPreview?.({
          kind: 'forward',
          ticket: item.ticket,
          destination,
          decision,
          address: destination.forward_email,
          subject: message.subject || item.ticket.subject,
          comment
        });
        continue;
      }

      let error = null;
      try {
        await graphClient.forwardMessage(message.graphMessageId, {
          comment,
          toRecipients: [destination.forward_email]
        });
        totals.forwarded += 1;
        firstSent ??= message;
      } catch (sendError) {
        error = sendError.message;
        totals.failed += 1;
        logger?.warn?.('forward.failed', {
          ticketId: item.ticket.id,
          destination: destination.label,
          reason: sendError.message
        });
      }

      // Recorded either way. A failure that left no row would be retried on every
      // poll forever; a row lets the next pass see it was tried and why.
      await store.recordForward({
        shopId,
        ticketId: item.ticket.id,
        messageId: message.messageId,
        category: item.ticket.category,
        address: destination.forward_email,
        destinationLabel: destination.label,
        error,
        // A transient failure is recorded but does not consume an attempt: the
        // worker polls every 60s, so counting « the mailbox is mid-move » would
        // exhaust the cap minutes before the mail became sendable.
        priorAttempts:
          error && isTransientGraphError(error)
            ? Math.max((message.priorAttempts ?? 1) - 1, 0)
            : message.priorAttempts ?? 0
      });
    }

    if (firstSent) {
      await acknowledge({ ticket: item.ticket, routing: decision, destination, message: firstSent });
    }
  }

  // Acknowledgements that failed on an earlier poll, now that the thread has
  // gone: retried against the first message forwarded on the ticket.
  if (!dryRun && typeof store.findAckRetries === 'function') {
    const retries = await store.findAckRetries(shopId, { maxAttempts: MAX_ACK_ATTEMPTS });
    for (const { routing, ticket, message } of retries) {
      const destination = active.find((d) => d.id === routing.destination_id);
      if (!destination) continue;
      await acknowledge({
        ticket,
        routing,
        destination,
        message: { messageId: message.id, graphMessageId: message.graph_message_id, fromEmail: message.from_email }
      });
    }
  }

  return totals;

  /**
   * The decision for this ticket: the stored one while the category and kind
   * it was taken on still hold, a new one otherwise. Returns null when the
   * router cannot decide yet (no chooser configured).
   */
  async function decide({ ticket, routing }) {
    if (
      routing &&
      routing.category === ticket.category &&
      (routing.request_kind ?? null) === (ticket.request_kind ?? null) &&
      !switchedOnSince(ticket.category, routing.decided_at)
    ) {
      return routing;
    }

    const plan = planRoute({ ticket, destinations: active });
    let decision;
    if (plan.route === 'stays') {
      // Nothing routes this ticket today; not worth a row, and a destination
      // added tomorrow should see it fresh.
      return { outcome: 'keep', method: 'fixed' };
    }
    if (plan.route === 'fixed') {
      decision = { outcome: 'forward', method: 'fixed', destination: plan.candidates[0] };
    } else {
      if (!chooser) return null;
      const thread = await store.loadThread(ticket.id);
      const fromEmail = thread[0]?.from_email ?? '';
      const choice = await chooser.choose(
        {
          subject: ticket.subject,
          messages: thread,
          senderDomain: fromEmail.split('@')[1] ?? null,
          senderLabel: senderDirectory?.lookup?.(fromEmail)?.label ?? null,
          language: ticket.language
        },
        plan.candidates,
        { ticketId: ticket.id }
      );
      decision = choice.destination
        ? { outcome: 'forward', method: 'model', destination: choice.destination, reason: choice.reason, model: choice.model }
        : { outcome: 'keep', method: 'model', reason: choice.reason, model: choice.model };
    }

    const view = {
      ...decision,
      destination_id: decision.destination?.id ?? null,
      destination_label: decision.destination?.label ?? null,
      // A new decision starts the acknowledgement afresh only if none was sent.
      ack_state: routing?.ack_state ?? null,
      ack_attempts: routing?.ack_attempts ?? 0
    };
    if (dryRun) {
      onPreview?.({ kind: 'route', ticket, decision: view });
      return view;
    }
    const row = await store.recordRouting(shopId, ticket, decision);
    return row ?? view;
  }

  /**
   * Whether a destination for this category was switched on after the decision
   * was taken. A b2b ticket kept while Export was off was never offered Export;
   * its next message is decided again now that it could go there.
   */
  function switchedOnSince(category, decidedAt) {
    if (!decidedAt) return false;
    const decided = Date.parse(decidedAt);
    return active.some((d) => (d.categories ?? []).includes(category) && Date.parse(d.active_since) > decided);
  }

  async function acknowledge({ ticket, routing, destination, message }) {
    const plan = planAcknowledgement({
      settings,
      destination,
      routing,
      recipient: message.fromEmail,
      internalDomains
    });
    if (plan.action === 'none') return;
    // ONCE PER CASE: another thread of the same customer problem was already
    // acknowledged, so this one is not (61_cases.sql).
    if (plan.action !== 'skip' && typeof store.caseAcknowledged === 'function' && (await store.caseAcknowledged(ticket.id))) {
      totals.ackSkipped += 1;
      if (!dryRun) await store.recordAck(ticket.id, { state: 'skipped', error: 'case_acknowledged' });
      return;
    }
    if (plan.action === 'skip') {
      totals.ackSkipped += 1;
      if (!dryRun) await store.recordAck(ticket.id, { state: 'skipped', error: plan.reason });
      return;
    }

    const bodyText = renderAcknowledgement({
      destination,
      settings,
      shopName,
      language: ackLanguage(ticket.language)
    });
    if (dryRun) {
      totals.acknowledged += 1;
      onPreview?.({ kind: 'ack', ticket, destination, recipient: message.fromEmail, bodyText });
      return;
    }
    if (!provider || !message.graphMessageId) {
      totals.ackSkipped += 1;
      await store.recordAck(ticket.id, { state: 'skipped', error: provider ? 'no_graph_id' : 'no_provider' });
      return;
    }

    const attempts = (routing?.ack_attempts ?? 0) + 1;
    let draftId;
    try {
      const draft = await provider.createReplyDraft(message.graphMessageId, { bodyText, to: [message.fromEmail] });
      draftId = draft.draftId;
    } catch (error) {
      // Nothing has left the mailbox: safe to try again on a later poll.
      totals.ackFailed += 1;
      await store.recordAck(ticket.id, { state: 'failed', error: error.message, attempts });
      logger?.warn?.('forward.ack_failed', { ticketId: ticket.id, reason: error.message });
      return;
    }

    // Written BEFORE the send, as the outbound worker does: a crash between the
    // two leaves « maybe sent », which is never retried into a second mail.
    await store.recordAck(ticket.id, { state: 'requested', attempts });
    try {
      await provider.sendDraft(draftId);
      await store.recordAck(ticket.id, { state: 'sent' });
      totals.acknowledged += 1;
    } catch (error) {
      totals.ackFailed += 1;
      await store.recordAck(ticket.id, { state: 'failed', error: error.message, attempts });
      logger?.warn?.('forward.ack_failed', { ticketId: ticket.id, reason: error.message });
    }
  }
}

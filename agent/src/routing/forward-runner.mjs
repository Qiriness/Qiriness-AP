import {
  buildForwardNote,
  isTransientGraphError,
  resolveAddress,
  shouldForward
} from './forward-rules.mjs';

// The forwarding pass: hand mail that asks nothing of customer support to the
// colleague who owns that subject. Runs after categorisation, because it reads
// the category and request_kind that step assigns.
//
// SAFE BY DEFAULT. A category with no configured address is never forwarded, so
// a fresh install sends nothing at all until somebody fills the address book in.
// There is no "forward everything" mode.
//
// ONE FAILURE DOES NOT STOP THE PASS. Each message is sent and recorded on its
// own; a Graph rejection on one becomes a `failed` row and the loop continues.
// The alternative — abort on first error — would let a single malformed address
// block every other category indefinitely.

export async function runForwarding({
  store,
  graphClient,
  shopId,
  logger,
  internalDomains = [],
  // Rehearsal: decide everything, send nothing, record nothing. The first real
  // run forwards the whole existing backlog at once, so being able to read the
  // list before it leaves the building is worth the flag.
  dryRun = false,
  onPreview
} = {}) {
  const addressByCategory = await store.loadAddressBook(shopId);
  if (addressByCategory.size === 0) {
    return { considered: 0, forwarded: 0, failed: 0, skipped: 0 };
  }

  const pending = await store.findPending(shopId, [...addressByCategory.keys()]);
  const totals = { considered: pending.length, forwarded: 0, failed: 0, skipped: 0 };

  for (const item of pending) {
    if (
      !shouldForward({
        ticket: item.ticket,
        fromEmail: item.fromEmail,
        addressByCategory,
        internalDomains
      })
    ) {
      totals.skipped += 1;
      continue;
    }
    // A message ingested before the Graph id was stored cannot be forwarded by
    // reference, and re-composing it would lose the attachments that are often
    // the entire point (a CV, a PO). Skipped rather than faked.
    if (!item.graphMessageId) {
      totals.skipped += 1;
      logger?.warn?.('forward.no_graph_id', { ticketId: item.ticket.id });
      continue;
    }

    const address = resolveAddress(item.ticket.category, addressByCategory);
    const comment = buildForwardNote({
      category: item.ticket.category,
      subject: item.subject || item.ticket.subject
    });

    if (dryRun) {
      totals.forwarded += 1;
      onPreview?.({
        category: item.ticket.category,
        address,
        subject: item.subject || item.ticket.subject,
        comment
      });
      continue;
    }

    let error = null;
    try {
      await graphClient.forwardMessage(item.graphMessageId, {
        comment,
        toRecipients: [address]
      });
      totals.forwarded += 1;
    } catch (sendError) {
      error = sendError.message;
      totals.failed += 1;
      logger?.warn?.('forward.failed', {
        ticketId: item.ticket.id,
        category: item.ticket.category,
        reason: sendError.message
      });
    }

    // Recorded either way. A failure that left no row would be retried on every
    // poll forever; a row lets the next pass see it was tried and why.
    await store.recordForward({
      shopId,
      ticketId: item.ticket.id,
      messageId: item.messageId,
      category: item.ticket.category,
      address,
      error,
      // A transient failure is recorded but does not consume an attempt: the
      // worker polls every 60s, so counting "the mailbox is mid-move" would
      // exhaust the cap minutes before the mail became sendable.
      priorAttempts: error && isTransientGraphError(error)
        ? Math.max((item.priorAttempts ?? 1) - 1, 0)
        : item.priorAttempts ?? 0
    });
  }

  return totals;
}

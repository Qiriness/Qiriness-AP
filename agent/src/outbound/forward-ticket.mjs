/**
 * A PERSON FORWARDING A TICKET TO COLLEAGUES (06_manual_forwards.sql), carried
 * by the worker from a `send_outbound` job whose payload names the forward.
 * Nothing is sent from the browser.
 *
 * WHAT GOES: the whole thread. Graph's `createForward` on the latest customer
 * message makes the draft — in the same conversation, so the colleague's reply
 * comes back to this ticket, and with that message's attachments on it. Above
 * the quoted original we put the person's note and every message of the
 * thread, dated and named, each with only its new text. The files of the other
 * messages are added one by one; one too large to add (Graph takes about 3 MB
 * this way) is listed by name in the body instead.
 *
 * WHAT IT IS NOT: an answer to the customer. Every recipient is ours (checked
 * by the dashboard), so the Sent Items copy is `internal_only` and the fold,
 * drafting and the reply target all skip it.
 */
import { parseEmailForDisplay } from '../../../scripts/lib/email-display.mjs';

/** Graph's limit for a file added to a draft in one request, with margin. */
export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

const escape = (text) =>
  String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const paragraphs = (text) =>
  escape(String(text ?? '').replace(/\r\n/g, '\n').trim())
    .split(/\n{2,}/)
    .map((block) => `<p style="margin:0 0 8px">${block.replace(/\n/g, '<br>')}</p>`)
    .join('');

const when = (message) => {
  const at = Date.parse(message.received_at ?? message.sent_at ?? '');
  return Number.isFinite(at)
    ? new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Paris' }).format(new Date(at))
    : 'date inconnue';
};

const who = (message) => {
  const name = message.from_name?.trim();
  const address = message.from_email?.trim();
  if (message.direction === 'outbound') return 'Service client';
  return name && address && name.toLowerCase() !== address.toLowerCase() ? `${name} <${address}>` : name || address || 'Expéditeur inconnu';
};

/**
 * The body above the quoted original. Pure, so it is tested as text.
 * @param messages the ticket's messages, oldest first
 * @param skipped  files that could not travel: `{ name, size, reason }`
 */
export function forwardBody({ note = null, forwardedByName = null, ticketLabel = null, messages = [], skipped = [] }) {
  const parts = [];
  if (note?.trim()) parts.push(`<div>${paragraphs(note)}</div>`);
  parts.push(
    `<p style="margin:12px 0 4px;color:#555">Transféré depuis le tableau de bord${ticketLabel ? ` (ticket ${escape(ticketLabel)})` : ''}` +
      `${forwardedByName ? ` par ${escape(forwardedByName)}` : ''}. Toute la conversation suit, du plus ancien au plus récent.</p>`
  );
  if (skipped.length > 0) {
    const list = skipped.map((file) => `<li>${escape(file.name || 'pièce jointe')} — non jointe (${file.reason === 'too_large' ? 'trop volumineuse' : 'introuvable'})</li>`).join('');
    parts.push(`<p style="margin:8px 0 4px;color:#555">Pièces jointes à consulter dans le ticket :</p><ul style="margin:0 0 8px">${list}</ul>`);
  }
  for (const message of messages) {
    const text = parseEmailForDisplay(message.body_text ?? '').bodyClean?.trim() || '(pas de texte)';
    parts.push(
      `<div style="border-left:3px solid #ccc;padding:4px 0 4px 10px;margin:10px 0">` +
        `<p style="margin:0 0 6px;color:#555"><strong>${escape(who(message))}</strong> — ${escape(when(message))}</p>` +
        `${paragraphs(text)}</div>`
    );
  }
  parts.push('<hr>');
  return parts.join('\n');
}

/** The message Graph forwards: the latest one from the customer, else the latest inbound one. */
export function sourceMessage(messages = []) {
  const usable = messages.filter((message) => message.graph_message_id && message.direction === 'inbound');
  const customer = usable.filter((message) => (message.actor ?? 'customer') === 'customer');
  return (customer.length ? customer : usable).at(-1) ?? null;
}

/**
 * Carries one forward as far as it may go. Returns the outcome to count:
 * `sent`, `held`, `failed`, `awaitingConfirmation` (it went before a crash) or
 * `closed` (nothing to do).
 */
export async function carryOutForward(forwardId, { forwards, store, provider, stopBeforeSend = false, logger, shopId }) {
  let forward = forwardId ? await forwards.get(forwardId) : null;
  if (!forward) return 'closed';

  if (forward.state === 'send_requested') {
    // Maybe sent: ask the mailbox before anything more.
    const where = await provider.findSentMessage({ draftId: forward.provider_draft_id });
    if (where === 'sent') {
      await forwards.markSent(forward.id);
      return 'sent';
    }
    if (where === 'missing') return fail('draft_missing');
    // Still a draft: nothing went. Back to draft_created's path below.
    forward = { ...forward, state: 'draft_created' };
  }

  if (forward.state === 'draft_created') {
    // A draft whose files may be half added: throw it away and start again,
    // rather than send something incomplete or attach a file twice.
    if (forward.provider_draft_id) await provider.deleteDraft(forward.provider_draft_id).catch(() => {});
    forward = await forwards.restart(forward.id);
    if (!forward) return 'closed';
  }

  if (forward.state !== 'queued') return 'closed';

  const [ticket, messages] = await Promise.all([store.ticket(forward.ticket_id), store.thread(forward.ticket_id)]);
  if (!ticket) return fail('ticket_missing');
  const source = sourceMessage(messages);
  if (!source) return fail('no_message_to_forward');
  const recipients = (forward.recipients ?? []).map((r) => r?.email).filter(Boolean);
  if (recipients.length === 0) return fail('no_recipient');

  // What can travel: every non-inline file of every other message, sized first
  // so the body can name what stays behind. The source's own files ride on the
  // forward already.
  const toAttach = [];
  const skipped = [];
  for (const message of messages) {
    if (message.id === source.id || !message.has_attachments || !message.graph_message_id) continue;
    const handles = (await provider.listAttachments(message.graph_message_id)) ?? [];
    for (const handle of handles) {
      if (handle.isInline || !handle.id) continue;
      if (handle.size > MAX_ATTACHMENT_BYTES) skipped.push({ name: handle.name, size: handle.size, reason: 'too_large' });
      else toAttach.push({ messageId: message.graph_message_id, handle });
    }
  }

  const html = forwardBody({
    note: forward.note,
    forwardedByName: forward.forwarded_by_name,
    ticketLabel: ticket.ticket_number ? `T-${ticket.ticket_number}` : null,
    messages,
    skipped
  });
  const draft = await provider.createForwardDraft(source.graph_message_id, { html, to: recipients });
  const recorded = await forwards.markDraftCreated(forward.id, {
    sourceMessageId: source.id,
    providerDraftId: draft.draftId,
    internetMessageId: draft.internetMessageId,
    attachmentsSkipped: skipped
  });
  // Another holder moved it meanwhile: its draft is the one that counts.
  if (!recorded) {
    await provider.deleteDraft(draft.draftId).catch(() => {});
    return 'closed';
  }

  let attached = 0;
  for (const { messageId, handle } of toAttach) {
    const file = await provider.getAttachment(messageId, handle.id, { maxBytes: MAX_ATTACHMENT_BYTES }).catch((error) => {
      if (error?.tooLarge) return null;
      throw error;
    });
    if (!file) continue;
    await provider.addDraftAttachment(draft.draftId, { name: handle.name, contentType: handle.contentType, bytes: file.buffer });
    attached += 1;
  }

  if (stopBeforeSend) {
    await forwards.markHeld(forward.id, { attachmentsSent: attached });
    logger?.info?.('forward.held_in_drafts', { shopId, forwardId: forward.id, ticketId: forward.ticket_id });
    return 'held';
  }
  if (!(await forwards.markSendRequested(forward.id, { attachmentsSent: attached }))) return 'closed';
  await provider.sendDraft(draft.draftId);
  await forwards.markSent(forward.id);
  logger?.info?.('forward.sent', { shopId, forwardId: forward.id, ticketId: forward.ticket_id, attached, skipped: skipped.length });
  return 'sent';

  async function fail(reason) {
    await forwards.markFailed(forward.id, reason);
    logger?.warn?.('forward.failed', { shopId, forwardId: forward.id, ticketId: forward.ticket_id, reason });
    return 'failed';
  }
}

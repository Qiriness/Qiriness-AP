/**
 * THE MAIL PROVIDER CONTRACT. Everything outside `agent/src/mail/` that reads
 * or writes a mailbox goes through an object of this shape, so a second
 * provider (Gmail) is one new adapter rather than a change to the poller, the
 * writer or the outbound worker.
 *
 * Implemented today by `outlook-graph-adapter.mjs` only.
 *
 * @typedef {'inbox' | 'sentitems'} MailFolder
 *
 * A message as the rest of the system sees it: what `mapGraphMessage` has
 * always produced, and what `ticket-writer.mjs` consumes. `message` is the
 * `ticket_messages` row and `conversation` the ticket-level facts.
 *
 * THE FIELD NAMES ARE HISTORICAL. `graphMessageId`, `conversationId` and the
 * row's `graph_message_id` / `graph_conversation_id` mean "the provider's
 * message id" and "the provider's thread id". They were not renamed
 * (decided 2026-09-28): the columns are the unique keys of a populated
 * table and are read in ~20 modules and the views. A Gmail adapter fills them
 * with Gmail's message id and threadId.
 *
 * @typedef {object} MailItem
 * @property {boolean} removed           a deletion tombstone; nothing else is set but the ids
 * @property {string|null} graphMessageId  the provider's message id
 * @property {string|null} conversationId  the provider's thread id
 * @property {object} [message]          the ticket_messages row
 * @property {object} [conversation]     requester, subject, message_at
 * @property {object|null} [contactForm] fields parsed from a contact-form notification
 *
 * @typedef {object} ChangePage
 * @property {MailItem[]} items
 * @property {string|null} nextCursor    more pages follow; resume here
 * @property {string|null} deltaCursor   the read is complete; the next read starts here
 *
 * @typedef {'sent' | 'draft' | 'missing'} SentState
 *
 * @typedef {object} MailProvider
 * @property {string} name
 * @property {(folder: MailFolder, cursor: string|null, options?: { top?: number, stableIds?: boolean }) => Promise<ChangePage>} getChanges
 *   One page of changes. A SAVED cursor the provider refuses throws `CursorExpiredError`.
 * @property {(id: string) => Promise<MailItem|null>} getMessage
 * @property {(id: string) => Promise<object[]|null>} getAttachmentMetadata  metadata only, never bytes
 * @property {(messageId: string, reply: { bodyText: string, to: string[] }) => Promise<{ draftId: string, internetMessageId: string|null }>} createReplyDraft
 * @property {(draftId: string) => Promise<void>} sendDraft
 * @property {(ref: { draftId: string }) => Promise<SentState>} findSentMessage
 *   Before any retry of a send: `sent` (it went), `draft` (it did not), `missing` (gone either way).
 */

export const MAIL_FOLDERS = ['inbox', 'sentitems'];

const REQUIRED_METHODS = [
  'getChanges',
  'getMessage',
  'getAttachmentMetadata',
  'createReplyDraft',
  'sendDraft',
  'findSentMessage'
];

/** A saved cursor the provider will no longer resume from. */
export class CursorExpiredError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = 'CursorExpiredError';
    this.status = status;
    this.code = code;
  }
}

/** Throws unless `provider` implements the whole contract. */
export function assertMailProvider(provider) {
  const missing = REQUIRED_METHODS.filter((name) => typeof provider?.[name] !== 'function');
  if (missing.length > 0) {
    throw new Error(`Not a MailProvider: missing ${missing.join(', ')}.`);
  }
  return provider;
}

/**
 * Plain reply text -> the HTML body a provider sends. Escaped, blank lines
 * become paragraphs, single newlines become line breaks. Nothing else: the
 * text is what a person approved, and markup it did not contain is not added.
 */
export function replyHtml(bodyText) {
  const escape = (text) =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  return String(bodyText ?? '')
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escape(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

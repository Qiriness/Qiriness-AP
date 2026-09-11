// Microsoft Graph client: app-only (client credentials) auth + inbox message
// delta reads. `fetchImpl` is injectable for tests; nothing here runs without
// Graph credentials (validated by assertGraphConfig before the worker polls).

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const DELTA_SELECT = [
  'id',
  'conversationId',
  'internetMessageId',
  // THE REPLY CHAIN, for deduplication. Graph has no `inReplyTo` property, so
  // the only route to `In-Reply-To` and `References` is the whole header
  // collection -- and it is a large thing to pull per message (SPF, DKIM, and a
  // `Received` line per relay hop). The mapper keeps exactly those two headers
  // and drops the rest before anything is stored: the discarded ones carry
  // relay IPs and hostnames, which is personal data with no use here.
  'internetMessageHeaders',
  'subject',
  'from',
  'toRecipients',
  'ccRecipients',
  'receivedDateTime',
  'sentDateTime',
  'bodyPreview',
  'body',
  'hasAttachments',
  'isDraft'
].join(',');

export function createGraphClient(config, { fetchImpl = fetch } = {}) {
  const { tenantId, clientId, clientSecret, mailbox } = config.graph;
  let cachedToken = null;
  let tokenExpiresAt = 0;

  async function getToken() {
    const now = Date.now();
    if (cachedToken && now < tokenExpiresAt - 60000) {
      return cachedToken;
    }

    const url = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
      scope: 'https://graph.microsoft.com/.default'
    });

    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      // error_description can echo request details but not the secret; still keep it terse.
      throw new Error(`Graph token request failed: ${payload?.error || `HTTP ${response.status}`}`);
    }

    cachedToken = payload.access_token;
    tokenExpiresAt = now + Number(payload.expires_in || 3600) * 1000;
    return cachedToken;
  }

  // Fetch one delta page. Pass the previous @odata.nextLink or @odata.deltaLink as
  // `url` to continue; pass null for the initial full read. `top` hints the page
  // size on the initial read (used to avoid over-fetching under a --limit).
  async function getDeltaPage(url = null, { top } = {}) {
    const token = await getToken();
    const target =
      url ||
      `${GRAPH_BASE}/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages/delta?$select=${DELTA_SELECT}`;

    const headers = { Authorization: `Bearer ${token}` };
    if (!url && top) {
      headers.Prefer = `odata.maxpagesize=${top}`;
    }

    const response = await fetchImpl(target, { headers });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`Graph delta request failed: ${payload?.error?.code || `HTTP ${response.status}`}`);
    }

    return {
      messages: Array.isArray(payload?.value) ? payload.value : [],
      nextLink: payload?.['@odata.nextLink'] || null,
      deltaLink: payload?.['@odata.deltaLink'] || null
    };
  }

  /**
   * One message by id, or null if the mailbox no longer holds it.
   *
   * Exists for the spam-audit body backfill: rows written before the body
   * columns existed recorded the decision and not the text, and the id is
   * the only handle back to the email. Selects exactly the delta fields, so a
   * message fetched here maps through `mapGraphMessage` to the same row
   * ingestion would have written.
   *
   * A MISSING MESSAGE IS AN ANSWER, NOT AN ERROR. Mail gets deleted, archived
   * and moved out of the Inbox by the humans who share this mailbox, and a
   * backfill over hundreds of rows will meet plenty of 404s. Returning null lets
   * the caller count them; throwing would make one deleted email end the run.
   *
   * BUT TWO DIFFERENT THINGS RETURN 404, and conflating them is a trap worth
   * naming. `ErrorItemNotFound` means the email is gone — permanent, per row,
   * nothing to do. `ErrorInvalidMailboxItemId` means the id was never valid for
   * THIS mailbox: Exchange item ids are mailbox-scoped, so an id captured while
   * `SUPPORT_MAILBOX` pointed somewhere else fails here for every row at once,
   * kept mail included. That is a configuration answer, not a data answer, and
   * reporting it as "gone, unrecoverable" sends the operator to fix the wrong
   * thing for ever. It throws, flagged, so a caller can stop and say so.
   */
  async function getMessage(graphMessageId) {
    if (!graphMessageId) {
      throw new Error('getMessage requires a Graph message id.');
    }
    const token = await getToken();
    const response = await fetchImpl(
      `${GRAPH_BASE}/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(graphMessageId)}?$select=${DELTA_SELECT}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const payload = await response.json().catch(() => null);
    const code = payload?.error?.code || '';

    if (code === 'ErrorInvalidMailboxItemId') {
      const error = new Error(
        `Graph rejected the message id as invalid for ${mailbox}. Exchange ids are ` +
          'mailbox-scoped, so these rows were almost certainly ingested while ' +
          'SUPPORT_MAILBOX pointed at a different mailbox.'
      );
      error.code = code;
      error.mailboxMismatch = true;
      throw error;
    }

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Graph message request failed: ${code || `HTTP ${response.status}`}`);
    }
    return payload;
  }

  /**
   * Attachment METADATA for one message. Never the bytes.
   *
   * `$select` is the whole safety story here. Graph's attachment resource
   * carries `contentBytes` — the entire file, base64 — and omitting the select
   * would pull a customer's multi-megabyte photo through this worker and into
   * whatever logs a failure touches, for a question answerable from four scalar
   * fields. Naming the four keeps the binary on Microsoft's side of the wire.
   *
   * `$top=20` because the question is "is a photo here", not "enumerate
   * everything": twenty parts is far past the point where a person should be
   * looking anyway, and it bounds the response on a mail with fifty inline
   * fragments.
   *
   * A MISSING MESSAGE IS AN ANSWER. Same contract as `getMessage`: null when the
   * mailbox no longer holds it, so a backfill over hundreds of rows counts
   * deletions instead of dying on the first one. `ErrorInvalidMailboxItemId`
   * still throws flagged, because that is a configuration answer and not a
   * per-row one.
   */
  async function getAttachmentMetadata(graphMessageId) {
    if (!graphMessageId) {
      throw new Error('getAttachmentMetadata requires a Graph message id.');
    }
    const token = await getToken();
    const response = await fetchImpl(
      `${GRAPH_BASE}/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(graphMessageId)}` +
        '/attachments?$select=id,name,contentType,size,isInline&$top=20',
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const payload = await response.json().catch(() => null);
    const code = payload?.error?.code || '';

    if (code === 'ErrorInvalidMailboxItemId') {
      const error = new Error(
        `Graph rejected the message id as invalid for ${mailbox}. Exchange ids are ` +
          'mailbox-scoped, so these rows were almost certainly ingested while ' +
          'SUPPORT_MAILBOX pointed at a different mailbox.'
      );
      error.code = code;
      error.mailboxMismatch = true;
      throw error;
    }

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Graph attachment request failed: ${code || `HTTP ${response.status}`}`);
    }

    return (Array.isArray(payload?.value) ? payload.value : []).map((attachment) => ({
      name: attachment?.name ?? null,
      contentType: attachment?.contentType ?? null,
      size: Number(attachment?.size) || 0,
      isInline: Boolean(attachment?.isInline)
    }));
  }

  /**
   * Forwards a message the mailbox already holds, with a covering note on top.
   *
   * Graph's own `/forward` action rather than composing a new message: it keeps
   * the original headers, body and attachments intact, so the recipient gets the
   * real email rather than the agent's rendering of it. A candidate's CV arrives
   * as a CV. Nothing has to be reconstructed from `ticket_messages`, which
   * stores stripped plain text and no attachments at all.
   *
   * THE ONLY WRITE THIS WORKER MAKES to Graph, and the only call needing the
   * `Mail.Send` application permission — everything else is Mail.Read. If that
   * permission has not been granted the send fails with ErrorAccessDenied,
   * which the caller records as a failed forward rather than retrying blindly.
   *
   * Returns nothing: Graph answers 202 Accepted with an empty body.
   */
  async function forwardMessage(graphMessageId, { comment, toRecipients }) {
    if (!graphMessageId) {
      throw new Error('forwardMessage requires a Graph message id.');
    }
    const recipients = (Array.isArray(toRecipients) ? toRecipients : [toRecipients])
      .map((address) => String(address || '').trim())
      .filter(Boolean);
    if (recipients.length === 0) {
      throw new Error('forwardMessage requires at least one recipient.');
    }

    const token = await getToken();
    const response = await fetchImpl(
      `${GRAPH_BASE}/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(graphMessageId)}/forward`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          comment: comment || '',
          toRecipients: recipients.map((address) => ({ emailAddress: { address } }))
        })
      }
    );

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(
        `Graph forward failed: ${payload?.error?.code || `HTTP ${response.status}`}`
      );
    }
  }


  /**
   * Attachment IDS as well as the four scalars, for the one caller that needs
   * to fetch something.
   *
   * SEPARATE FROM `getAttachmentMetadata` AND DELIBERATELY SO. That function's
   * whole documented contract is that the id never travels: it answers "is a
   * photo here" and its result is written to `ticket_messages.attachments`,
   * where an Exchange item id would be a mailbox-scoped handle stored beside
   * data that outlives the mailbox. This one is read at request time, used
   * immediately, and never persisted.
   */
  async function listAttachmentHandles(graphMessageId) {
    if (!graphMessageId) {
      throw new Error('listAttachmentHandles requires a Graph message id.');
    }
    const token = await getToken();
    const response = await fetchImpl(
      `${GRAPH_BASE}/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(graphMessageId)}` +
        '/attachments?$select=id,name,contentType,size,isInline&$top=20',
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const payload = await response.json().catch(() => null);
    const code = payload?.error?.code || '';

    if (code === 'ErrorInvalidMailboxItemId') {
      const error = new Error(
        `Graph rejected the message id as invalid for ${mailbox}. Exchange ids are ` +
          'mailbox-scoped, so these rows were almost certainly ingested while ' +
          'SUPPORT_MAILBOX pointed at a different mailbox.'
      );
      error.code = code;
      error.mailboxMismatch = true;
      throw error;
    }

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Graph attachment request failed: ${code || `HTTP ${response.status}`}`);
    }

    return (Array.isArray(payload?.value) ? payload.value : []).map((attachment) => ({
      id: attachment?.id ?? null,
      name: attachment?.name ?? null,
      contentType: attachment?.contentType ?? null,
      size: Number(attachment?.size) || 0,
      isInline: Boolean(attachment?.isInline)
    }));
  }

  /**
   * The bytes of one attachment. THE ONLY PLACE THIS PROJECT READS A FILE A
   * CUSTOMER SENT.
   *
   * `/$value` RATHER THAN `contentBytes`. The attachment resource returns the
   * file base64-encoded inside a JSON envelope, which costs a third more bytes
   * over the wire and forces the whole thing through `JSON.parse` before
   * anything can look at it. `/$value` is the raw file with a real
   * `Content-Type`, so it streams.
   *
   * `maxBytes` IS A REFUSAL, NOT A TRUNCATION. A truncated image is a corrupt
   * image, and handing a browser half a JPEG is worse than telling it no: the
   * caller shows "too large to display" and the operator opens Outlook. The cap
   * exists because Graph will happily hand back the 12 MB video in this corpus
   * and the dashboard has no business streaming that into a table row.
   *
   * A MISSING MESSAGE IS AN ANSWER, the same contract as the rest of this file:
   * null when the mailbox no longer holds it. Historical mail leaves — measured
   * on this corpus, at least one message with a stored photo is already gone —
   * so a caller has to render that state rather than treat it as an error.
   */
  async function getAttachmentContent(graphMessageId, attachmentId, { maxBytes = 8 * 1024 * 1024 } = {}) {
    if (!graphMessageId || !attachmentId) {
      throw new Error('getAttachmentContent requires a message id and an attachment id.');
    }
    const token = await getToken();
    const response = await fetchImpl(
      `${GRAPH_BASE}/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(graphMessageId)}` +
        `/attachments/${encodeURIComponent(attachmentId)}/$value`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Graph attachment content failed: HTTP ${response.status}`);
    }

    // Checked before reading the body where Graph declares a length, and again
    // after: `content-length` is absent on a chunked response, so it is a cheap
    // first gate rather than the guarantee.
    const declared = Number(response.headers?.get?.('content-length')) || 0;
    if (declared > maxBytes) {
      const error = new Error(`Attachment is ${declared} bytes, over the ${maxBytes} cap.`);
      error.tooLarge = true;
      throw error;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      const error = new Error(`Attachment is ${buffer.byteLength} bytes, over the ${maxBytes} cap.`);
      error.tooLarge = true;
      throw error;
    }

    return {
      buffer,
      // Graph's own header, kept only to compare against what we stored. The
      // caller serves the STORED type, so a mailbox that starts describing a
      // file differently cannot change what the browser is told to render.
      contentType: response.headers?.get?.('content-type') || null
    };
  }

  return {
    getToken,
    getDeltaPage,
    getMessage,
    getAttachmentMetadata,
    listAttachmentHandles,
    getAttachmentContent,
    forwardMessage
  };
}

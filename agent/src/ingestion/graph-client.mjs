// Microsoft Graph client: app-only (client credentials) auth + inbox message
// delta reads. `fetchImpl` is injectable for tests; nothing here runs without
// Graph credentials (validated by assertGraphConfig before the worker polls).

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const DELTA_SELECT = [
  'id',
  'conversationId',
  'internetMessageId',
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
   * Exists for the spam-audit body backfill: rows written before
   * 08_spam_audit_body.sql recorded the decision and not the text, and the id is
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

  return { getToken, getDeltaPage, getMessage, forwardMessage };
}

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

  return { getToken, getDeltaPage };
}

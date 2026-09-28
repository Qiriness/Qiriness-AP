import { mapGraphMessage } from '../ingestion/graph-message-mapper.mjs';
import { CursorExpiredError, assertMailProvider, replyHtml } from './mail-provider.mjs';

/**
 * Microsoft 365 behind the MailProvider contract (mail-provider.mjs).
 *
 * A thin wrapper, deliberately: `graph-client.mjs` keeps every Graph detail
 * that was measured against the live mailbox (immutable ids, page sizes, the
 * wrong-mailbox codes), and `graph-message-mapper.mjs` keeps the mapping.
 * This file only translates between them and the contract, so nothing else
 * sees a Graph payload or a Graph error flag.
 *
 * `mailbox` is the support address: a message it sent is outbound.
 */
export function createOutlookGraphAdapter({ graphClient, mailbox = null }) {
  if (!graphClient) throw new Error('createOutlookGraphAdapter requires a graphClient.');

  return assertMailProvider({
    name: 'outlook',

    async getChanges(folder, cursor = null, { top, stableIds = false } = {}) {
      let page;
      try {
        page = await graphClient.getDeltaPage(cursor, { top, immutableIds: stableIds, folder });
      } catch (error) {
        // Graph refusing a link it issued (400 corrupted, 410 expired). Only
        // meaningful for a SAVED cursor; the poller decides that.
        if (cursor && error?.linkRejected) {
          throw new CursorExpiredError(error.message, { status: error.status ?? null, code: error.code ?? null });
        }
        throw error;
      }
      // Sent Items holds only our mail, whoever the envelope names.
      const direction = folder === 'sentitems' ? 'outbound' : undefined;
      return {
        items: (page.messages || []).map((raw) => mapGraphMessage(raw, { mailbox, direction })),
        nextCursor: page.nextLink || null,
        deltaCursor: page.deltaLink || null
      };
    },

    async getMessage(id) {
      const raw = await graphClient.getMessage(id);
      return raw ? mapGraphMessage(raw, { mailbox }) : null;
    },

    async getAttachmentMetadata(id) {
      if (typeof graphClient.getAttachmentMetadata !== 'function') return null;
      return graphClient.getAttachmentMetadata(id);
    },

    async createReplyDraft(messageId, { bodyText, to }) {
      const draft = await graphClient.createReplyDraft(messageId, { html: replyHtml(bodyText), toRecipients: to });
      return { draftId: draft.id, internetMessageId: draft.internetMessageId ?? null };
    },

    async sendDraft(draftId) {
      await graphClient.sendDraft(draftId);
    },

    async findSentMessage({ draftId }) {
      const state = await graphClient.getDraftState(draftId);
      if (!state) return 'missing';
      return state.isDraft ? 'draft' : 'sent';
    }
  });
}

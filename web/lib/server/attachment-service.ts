/**
 * Server-only reader for one photo a customer attached.
 *
 * NOTHING IS STORED. The image is fetched from Graph when a browser asks for it
 * and streamed straight back; no bucket, no `bytea`, no cache on disk. That is
 * the decision recorded in `DECISIONS.md` § "The photo itself is not stored",
 * and its point is that the compliance question stays "who may look at this"
 * instead of also becoming "what do we now keep, and for how long". The cost is
 * two Graph calls per view and a picture that disappears when the mail does.
 *
 * THE INDEX IS A POSITION IN THE TICKET'S OWN LIST, not an attachment id, and
 * that is the whole authorisation model. A request names a ticket and an offset
 * into the images `listTicketAttachments` derives for it; anything that is not
 * in that list cannot be addressed, so no crafted id reaches another customer's
 * mail. Exchange ids are never accepted from the browser and never rendered
 * into a page.
 *
 * IMAGES ONLY. The list also holds CVs, catalogues and invoices, and this
 * refuses them: the panel shows their names because that tells an operator what
 * kind of ticket they have, but a route that streams arbitrary files out of the
 * support mailbox is a different thing from one that shows a photo of a broken
 * bottle, and only the second was asked for.
 */

import { assertGraphConfig, loadAgentConfig } from "../../../agent/src/config.mjs";
import { createGraphClient } from "../../../agent/src/ingestion/graph-client.mjs";
import { listTicketAttachments } from "../../../scripts/lib/photo-evidence-rules.mjs";
import { createTicketRecord } from "../../../scripts/lib/ticket-record.mjs";
import { createSupabaseClient } from "../../../scripts/lib/supabase-rest-client.mjs";
import { loadConfig } from "../../../scripts/lib/sync-config.mjs";
import { COLUMNS } from "../../../scripts/lib/tables.mjs";
import { KnowledgeNotFoundError } from "./knowledge-errors";

/**
 * Why a photo could not be served. Each is a different sentence in the panel,
 * because they are different situations for the person reading it: a message
 * that has left the mailbox is gone for good, and a misconfigured mailbox is
 * somebody's afternoon.
 */
export type AttachmentFailure =
  | "not_found"
  | "message_gone"
  | "mailbox_mismatch"
  | "too_large"
  | "graph_not_configured"
  | "graph_unavailable";

export interface AttachmentResult {
  ok: true;
  body: Buffer;
  /** The STORED content type, never Graph's — see below. */
  contentType: string;
  name: string;
}

export interface AttachmentError {
  ok: false;
  reason: AttachmentFailure;
  detail?: string;
}

/** Graph will hand back the 12 MB video in this corpus; the panel will not. */
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * One entry as the shared projection returns it, before the public mapping
 * strips the addressing. Declared here because `listTicketAttachments` is
 * untyped `.mjs` and this file is the one that needs the server-side half.
 */
interface ListedPart {
  name: string | null;
  contentType: string | null;
  size: number;
  messageId: string | null;
  partIndex: number;
}

export async function getTicketPhoto(
  shopId: string,
  ticketId: string,
  index: number
): Promise<AttachmentResult | AttachmentError> {
  if (!Number.isInteger(index) || index < 0) {
    throw new KnowledgeNotFoundError(`No such attachment: ${index}`);
  }

  const supabase = createSupabaseClient(
    loadConfig(process.env as Record<string, string | undefined>)
  );
  const record = createTicketRecord(supabase, { shopId });
  const messages = await record.inboundMessages(ticketId, {
    columns: COLUMNS.messageForAttachments,
  });

  // The same derivation the panel rendered, so the offset a browser sends means
  // what it meant when the page was built. Recomputing rather than trusting the
  // client is also what keeps the furniture rules load-bearing: a signature logo
  // is not in `images`, so it cannot be requested.
  const listed = listTicketAttachments(Array.isArray(messages) ? messages : []) as {
    images: ListedPart[];
  };
  const file: ListedPart | undefined = listed.images[index];

  if (!file) {
    return { ok: false, reason: "not_found" };
  }
  if (!/^image\//i.test(String(file.contentType || ""))) {
    // Belt and braces: `images` is already image-only by construction.
    return { ok: false, reason: "not_found" };
  }
  if (!file.messageId) {
    // A promoted message from `spam_audit` has attachment metadata and no Graph
    // id — there is nothing to fetch against.
    return { ok: false, reason: "message_gone" };
  }
  if (file.size > MAX_BYTES) {
    return { ok: false, reason: "too_large" };
  }

  // CHECKED BEFORE THE CALL, because the call cannot tell you this. A deployment
  // missing `MS_GRAPH_*` builds a client with undefined credentials, posts to
  // `login.microsoftonline.com/undefined/...` and fails with `invalid_request` —
  // which lands in the same `graph_unavailable` bucket as a genuine Graph
  // outage, and reached the operator as « the message may have left the
  // mailbox ». `loadAgentConfig` does not require these vars (the worker needs
  // them, a sync script does not), so nothing upstream catches it either.
  //
  // Measured 2026-09-20: this is exactly what a Vercel deploy did, while the
  // same code served every photo locally from the repo-root `.env.local`.
  const config = loadAgentConfig();
  try {
    assertGraphConfig(config);
  } catch (error: any) {
    return { ok: false, reason: "graph_not_configured", detail: error?.message };
  }

  const graph = createGraphClient(config);

  let handles;
  try {
    handles = await graph.listAttachmentHandles(file.messageId);
  } catch (error: any) {
    if (error?.mailboxMismatch) {
      return { ok: false, reason: "mailbox_mismatch", detail: error.message };
    }
    return { ok: false, reason: "graph_unavailable", detail: error?.message };
  }

  if (handles === null) {
    return { ok: false, reason: "message_gone" };
  }

  const handle = matchHandle(handles, file);
  if (!handle?.id) {
    return { ok: false, reason: "not_found" };
  }

  try {
    const content = await graph.getAttachmentContent(file.messageId, handle.id, {
      maxBytes: MAX_BYTES,
    });
    if (content === null) {
      return { ok: false, reason: "message_gone" };
    }
    return {
      ok: true,
      body: content.buffer,
      // THE STORED TYPE WINS. Serving whatever Graph currently says would let a
      // mailbox decide what the browser renders a URL under this origin as,
      // which is the shape of a stored-XSS bug. What we stored was classified as
      // an image by the same rules that decided to list it.
      contentType: String(file.contentType),
      name: String(file.name || "photo"),
    };
  } catch (error: any) {
    if (error?.tooLarge) {
      return { ok: false, reason: "too_large", detail: error.message };
    }
    return { ok: false, reason: "graph_unavailable", detail: error?.message };
  }
}

/**
 * Which of Graph's parts is the one we listed.
 *
 * NAME AND SIZE FIRST, POSITION ONLY AS A FALLBACK. The stored metadata and the
 * live list are two readings of the same message taken weeks apart, and the
 * pair (name, size) identifies a part far more securely than its offset: parts
 * are returned in a stable order in practice, but "in practice" is not a thing
 * to serve a customer's photo on when an exact match is available.
 *
 * Falling back to the index at all is deliberate: a message can carry two
 * identically named parts (`image001.png` twice is common), and refusing to
 * show anything in that case would be a worse answer than showing the one at
 * the position we recorded.
 */
function matchHandle(handles: any[], file: ListedPart) {
  const byNameAndSize = handles.find(
    (handle) => handle?.name === file.name && Number(handle?.size) === Number(file.size)
  );
  if (byNameAndSize) return byNameAndSize;

  const byName = handles.filter((handle) => handle?.name === file.name);
  if (byName.length === 1) return byName[0];

  return handles[file.partIndex] ?? null;
}

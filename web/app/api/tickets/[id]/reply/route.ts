import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSession } from "@/lib/server/auth";
import { getShopId } from "@/lib/server/knowledge-service";
import { sendManualReply } from "@/lib/server/tickets-service";
import { knowledgeErrorResponse, KnowledgeValidationError } from "@/lib/server/knowledge-errors";
import { ticketsChanged } from "@/lib/server/cache-tags";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: { id: string };
}

/** Longer than any reply a person types; a paste of a whole thread is refused. */
const MAX_HTML = 100_000;

/**
 * Queues a reply a person wrote on the ticket page, with no draft behind it.
 *
 * NOTHING HERE SENDS. Like an approval, it records an outbound action and a
 * job; the worker sends it after checking the customer has not written since
 * (agent/src/outbound). The HTML is sanitised by the service before it is
 * stored, whatever the browser sent.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const body = await request.json().catch(() => ({}));
    const bodyHtml = typeof body.bodyHtml === "string" ? body.bodyHtml : "";
    const replyToMessageId = typeof body.replyToMessageId === "string" ? body.replyToMessageId : "";
    const clientKey = typeof body.clientKey === "string" ? body.clientKey : "";

    if (!bodyHtml.trim() || bodyHtml.length > MAX_HTML) {
      throw new KnowledgeValidationError("The reply is empty or too long.");
    }
    if (!replyToMessageId || !clientKey) {
      throw new KnowledgeValidationError("replyToMessageId and clientKey are required.");
    }

    const [shopId, session] = await Promise.all([getShopId(), getSession()]);
    const reply = await sendManualReply(
      shopId,
      params.id,
      { bodyHtml, replyToMessageId, clientKey },
      // Who asked for the send: the user's id, never a name or an address.
      session?.sub ?? null
    );
    ticketsChanged();
    return NextResponse.json({ reply });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getShopId } from "@/lib/server/knowledge-service";
import { promoteDroppedMail } from "@/lib/server/dropped-mail-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: { id: string };
}

/**
 * Overturns one spam-gate drop: the email becomes a ticket.
 *
 * POST rather than PATCH, and the id is the `spam_audit` row's: this creates
 * something (a ticket, or a message on an existing one) rather than editing the
 * decision it was read from. The audit row is never written to — see
 * dropped-mail-service.
 *
 * Idempotent all the same. The message upsert is keyed on `(shop_id,
 * graph_message_id)`, so a double click promotes once and answers with the same
 * ticket both times.
 *
 * Returns the ticket in the list's own projection, so the row can move from the
 * Irrelevant section into the queue without a reload.
 */
export async function POST(_request: NextRequest, { params }: RouteParams) {
  try {
    const shopId = await getShopId();
    const { ticket, ticketCreated } = await promoteDroppedMail(shopId, params.id);
    return NextResponse.json({ ticket, ticketCreated });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

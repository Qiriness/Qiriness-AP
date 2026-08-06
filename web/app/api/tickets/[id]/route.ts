import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getShopId } from "@/lib/server/knowledge-service";
import { getTicketDetail, setTicketStatus } from "@/lib/server/tickets-service";
import { knowledgeErrorResponse, KnowledgeValidationError } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: { id: string };
}

/**
 * The agent's reading of one ticket, for the expanded row.
 *
 * Per ticket rather than folded into the list read: an operator opens one row at
 * a time, so the case files are fetched when a row is opened and not before.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const shopId = await getShopId();
    const detail = await getTicketDetail(shopId, params.id);
    return NextResponse.json({ detail });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

/**
 * The only ticket mutation the dashboard has: move one between the queue and
 * the closed section.
 *
 * Deliberately narrow. `awaiting_customer`, `forwarded` and `spam` are the
 * worker's to set from what it observed — an operator asserting them by hand
 * would put the UI and the pipeline in disagreement about what happened.
 */
const ALLOWED = new Set(["open", "resolved", "closed"]);

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const body = await request.json().catch(() => ({}));
    const status = body?.status;

    if (typeof status !== "string" || !ALLOWED.has(status)) {
      throw new KnowledgeValidationError(
        `status must be one of ${[...ALLOWED].join(", ")}.`
      );
    }

    const shopId = await getShopId();
    const ticket = await setTicketStatus(shopId, params.id, status as "open" | "resolved" | "closed");
    return NextResponse.json({ ticket });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

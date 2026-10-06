import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSession } from "@/lib/server/auth";
import { getShopId } from "@/lib/server/knowledge-service";
import { snoozeTicket, unsnoozeTicket } from "@/lib/server/snooze-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";
import type { SnoozeWaitingFor } from "@/lib/types";
import { ticketsChanged } from "@/lib/server/cache-tags";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: { id: string };
}

/**
 * A person snoozes a ticket: out of the queue until a time, or until a party
 * writes (with the shop's delay for that party as the deadline). New mail from
 * anyone but us wakes it sooner, in the worker. Nothing else about the ticket
 * changes: status, drafts and checks stay as they are.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const body = await request.json().catch(() => ({}));
    const [shopId, session] = await Promise.all([getShopId(), getSession()]);
    const snooze = await snoozeTicket(
      shopId,
      params.id,
      {
        waitingFor: String(body.waitingFor ?? "") as SnoozeWaitingFor,
        until: typeof body.until === "string" && body.until ? body.until : null,
        reason: typeof body.reason === "string" ? body.reason : null,
      },
      // The user's id, never a name or an address.
      session?.sub ?? null
    );
    ticketsChanged();
    return NextResponse.json({ snooze });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

/** Wake it now: back in the queue, with « manual » as the reason. */
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const [shopId, session] = await Promise.all([getShopId(), getSession()]);
    const wake = await unsnoozeTicket(shopId, params.id, session?.sub ?? null);
    ticketsChanged();
    return NextResponse.json({ wake });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

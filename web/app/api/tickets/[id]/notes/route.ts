import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSession } from "@/lib/server/auth";
import { getShopId } from "@/lib/server/knowledge-service";
import { addTicketNote, listTicketNotes } from "@/lib/server/ticket-notes-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: { id: string };
}

/** The ticket's internal notes, oldest first. */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const [shopId, session] = await Promise.all([getShopId(), getSession()]);
    const notes = await listTicketNotes(shopId, params.id, session?.sub ?? null);
    return NextResponse.json({ notes });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

/**
 * A person leaves a note for the team. Nothing else about the ticket changes:
 * it is not a reply, it does not move the status, and the agent does not read it.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const body = await request.json().catch(() => ({}));
    const [shopId, session] = await Promise.all([getShopId(), getSession()]);
    const note = await addTicketNote(shopId, params.id, typeof body.body === "string" ? body.body : "", session);
    return NextResponse.json({ note });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

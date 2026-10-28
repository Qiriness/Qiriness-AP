import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSession } from "@/lib/server/auth";
import { getShopId } from "@/lib/server/knowledge-service";
import { deleteTicketNote } from "@/lib/server/ticket-notes-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: { id: string; noteId: string };
}

/** Removes a note from the timeline; only its writer may. */
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const [shopId, session] = await Promise.all([getShopId(), getSession()]);
    await deleteTicketNote(shopId, params.id, params.noteId, session?.sub ?? null);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

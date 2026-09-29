import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getShopId } from "@/lib/server/knowledge-service";
import { saveTicketOverrides } from "@/lib/server/tickets-service";
import { getSession } from "@/lib/server/auth";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: { id: string };
}

/**
 * A person's corrections from « Edit case »: `{ changes, expected, source }`,
 * where `changes` maps a field to its new value, or to null to reset it to
 * automatic. Records the user's id, never a name. Sends nothing and runs no
 * model: a new investigation, when one is due, is queued for the next poll.
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const body = await request.json().catch(() => ({}));
    const shopId = await getShopId();
    const session = await getSession();
    const result = await saveTicketOverrides(
      shopId,
      params.id,
      { changes: body?.changes, expected: body?.expected, source: body?.source },
      session?.sub ?? null
    );
    return NextResponse.json(result);
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSession } from "@/lib/server/auth";
import { getShopId } from "@/lib/server/knowledge-service";
import { forwardTicket } from "@/lib/server/manual-forward-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";
import { ticketsChanged } from "@/lib/server/cache-tags";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: { id: string };
}

/**
 * A person forwards the ticket's whole thread to colleagues: `recipients` are
 * picker keys (`team:<id>`, `destination:<id>`) or typed internal addresses.
 * Queued for the worker; nothing is sent from here.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const body = await request.json().catch(() => ({}));
    const [shopId, session] = await Promise.all([getShopId(), getSession()]);
    const forward = await forwardTicket(shopId, params.id, { recipients: body.recipients, note: body.note, clientKey: body.clientKey }, session);
    ticketsChanged();
    return NextResponse.json({ forward });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

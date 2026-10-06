import { NextResponse } from "next/server";
import { getShopId } from "@/lib/server/knowledge-service";
import { listTickets } from "@/lib/server/tickets-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";
import { logDashboardAccess } from "@/lib/server/access-log";

export const dynamic = "force-dynamic";

/**
 * The Closed tab's threads, read when the tab is first opened. /tickets renders
 * the open threads only: closed and resolved ones were ~95% of what every visit
 * downloaded (2026-10-06).
 */
export async function GET() {
  try {
    const shopId = await getShopId();
    const tickets = await listTickets(shopId, { scope: "closed" });
    await logDashboardAccess({
      shopId,
      action: "view",
      resourceType: "tickets",
      purpose: "support_queue",
      metadata: { surface: "tickets_closed", tickets: tickets.length },
    });
    return NextResponse.json({ tickets });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

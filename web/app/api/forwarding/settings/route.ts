import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getShopId } from "@/lib/server/knowledge-service";
import { saveAckSettings, setForwardingOn } from "@/lib/server/forwarding-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";

/**
 * Either the master switch (`{ forwardingOn }`) or the acknowledgement: on/off
 * and the FR/EN templates (empty restores the default). One or the other per
 * request, so saving the templates can never move the start date.
 */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    if (typeof body.forwardingOn === "boolean") {
      const forwardSince = await setForwardingOn(await getShopId(), body.forwardingOn);
      return NextResponse.json({ forwardSince });
    }
    const settings = await saveAckSettings(await getShopId(), body);
    return NextResponse.json({ settings });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

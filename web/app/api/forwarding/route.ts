import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getShopId } from "@/lib/server/knowledge-service";
import { listForwarding, saveForwarding } from "@/lib/server/forwarding-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";

/** Every ticket category with its forwarding address (null where unset). */
export async function GET() {
  try {
    const shopId = await getShopId();
    const forwarding = await listForwarding(shopId);
    return NextResponse.json({ forwarding });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

/**
 * Sets one category's forwarding address. An empty or omitted `forwardEmail`
 * clears it, which is how a category is turned off — absence is the off switch.
 */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    if (typeof body.category !== "string") {
      return NextResponse.json({ error: "category is required." }, { status: 400 });
    }
    const shopId = await getShopId();
    const entry = await saveForwarding(
      shopId,
      body.category,
      typeof body.forwardEmail === "string" ? body.forwardEmail : null
    );
    return NextResponse.json({ entry });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

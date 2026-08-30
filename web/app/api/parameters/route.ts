import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { getShopId, listParameters, setParameter } from "@/lib/server/parameters-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Every parameter the codebase knows about, set or not. */
export async function GET() {
  try {
    const shopId = await getShopId();
    return NextResponse.json({ parameters: await listParameters(shopId) });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

/**
 * Sets one parameter, or clears it with a null.
 *
 * NO APPROVAL STEP, unlike a rule. A parameter is a fact about the business
 * rather than a behaviour: there is no state in which the number is decided and
 * should not yet be used, and an approval flag would only be a second place for
 * "which number is live" to be wrong.
 */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const shopId = await getShopId();
    const parameter = await setParameter(
      shopId,
      String(body.key ?? ""),
      body.value === null || body.value === undefined ? null : String(body.value),
    );
    return NextResponse.json({ parameter });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

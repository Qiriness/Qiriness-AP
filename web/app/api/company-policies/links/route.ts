import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { getSession } from "@/lib/server/auth";
import { getShopId } from "@/lib/server/parameters-service";
import { linkCompanyPolicy, unlinkCompanyPolicy } from "@/lib/server/company-policy-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Make a policy available to a situation (`situationKey`) or to one rule (`answerId`). */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const [shopId, session] = await Promise.all([getShopId(), getSession()]);
    const link = await linkCompanyPolicy(
      shopId,
      {
        policyKey: String(body.policyKey ?? ""),
        situationKey: typeof body.situationKey === "string" && body.situationKey ? body.situationKey : null,
        answerId: typeof body.answerId === "string" && body.answerId ? body.answerId : null,
      },
      session?.sub ?? null
    );
    return NextResponse.json({ link });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

/** Remove one link (`?id=`). The policy itself is untouched. */
export async function DELETE(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get("id") ?? "";
    const removed = await unlinkCompanyPolicy(await getShopId(), id);
    return NextResponse.json({ removed });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { getSession } from "@/lib/server/auth";
import { getShopId } from "@/lib/server/parameters-service";
import { createCompanyPolicy, listCompanyPolicies } from "@/lib/server/company-policy-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Every company policy, with its links. */
export async function GET() {
  try {
    return NextResponse.json({ policies: await listCompanyPolicies(await getShopId()) });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

/** A new policy. Its key is fixed from here on: the agent and every link name it. */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const [shopId, session] = await Promise.all([getShopId(), getSession()]);
    const policy = await createCompanyPolicy(
      shopId,
      {
        key: String(body.key ?? "").trim(),
        name: String(body.name ?? ""),
        purpose: typeof body.purpose === "string" ? body.purpose : "",
        content: String(body.content ?? ""),
        active: body.active !== false,
      },
      session?.sub ?? null
    );
    return NextResponse.json({ policy });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

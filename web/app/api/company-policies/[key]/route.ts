import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { getSession } from "@/lib/server/auth";
import { getShopId } from "@/lib/server/parameters-service";
import { saveCompanyPolicy } from "@/lib/server/company-policy-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteParams {
  params: { key: string };
}

/**
 * Save a policy: name, purpose, text, active. A change of text raises the
 * version, and every situation and rule linked to it reads the new text from
 * the next reply on. Refused when someone else saved since the editor loaded.
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const body = await request.json().catch(() => ({}));
    const [shopId, session] = await Promise.all([getShopId(), getSession()]);
    const policy = await saveCompanyPolicy(
      shopId,
      params.key,
      {
        name: typeof body.name === "string" ? body.name : undefined,
        purpose: typeof body.purpose === "string" ? body.purpose : undefined,
        content: typeof body.content === "string" ? body.content : undefined,
        active: typeof body.active === "boolean" ? body.active : undefined,
        expectedVersion: Number.isInteger(body.expectedVersion) ? body.expectedVersion : undefined,
      },
      session?.sub ?? null
    );
    return NextResponse.json({ policy });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

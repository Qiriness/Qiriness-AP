import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getShopId } from "@/lib/server/knowledge-service";
import { createDestination } from "@/lib/server/forwarding-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";

/** Adds a destination. Validation is the shared module's; a refusal comes back as a 400 with one sentence. */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const destination = await createDestination(await getShopId(), body);
    return NextResponse.json({ destination }, { status: 201 });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

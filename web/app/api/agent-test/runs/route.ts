import { NextResponse } from "next/server";

import { checkReadiness, getShopId, listRuns } from "@/lib/server/agent-test-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The test-run history, newest first, without the traces.
 *
 * Readiness travels with it because the two are always wanted together: the
 * dialog opens on the history and has to be able to say, before anything is
 * typed, that there is no OpenAI key or no approved brand voice. Both answers
 * are free.
 */
export async function GET() {
  try {
    const shopId = await getShopId();
    const [runs, readiness] = await Promise.all([listRuns(shopId), checkReadiness(shopId)]);
    return NextResponse.json({ runs, readiness });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

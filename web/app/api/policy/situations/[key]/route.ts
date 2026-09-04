import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { getShopId, setCollectionMode } from "@/lib/server/policy-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Turns rule-directed collection on or off for one situation.
 *
 * A SEPARATE ENDPOINT FROM THE RULES, because it is a different decision about a
 * different table: a rule says what the answer is, this says whether the rules
 * for this situation are trusted to decide what gets collected. Folding it into
 * the rule save would mean editing a rule could quietly change how every ticket
 * in the situation is investigated.
 */
export async function PATCH(request: NextRequest, { params }: { params: { key: string } }) {
  try {
    const shopId = await getShopId();
    const body = await request.json();
    const mode = body?.collectionMode === "rule_directed" ? "rule_directed" : "model";
    await setCollectionMode(shopId, params.key, mode);
    return NextResponse.json({ key: params.key, collectionMode: mode });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import {
  getShopId,
  listAutomaticOffers,
  setOfferDescribable,
} from "@/lib/server/promotions-service";
import { knowledgeErrorResponse, KnowledgeValidationError } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The active automatic offers, each with whether support may describe it. */
export async function GET() {
  try {
    return NextResponse.json({ offers: await listAutomaticOffers(await getShopId()) });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

/**
 * Keeps one automatic offer out of replies, or lets it back in.
 *
 * Writes only `describable_in_replies`, the column the sync does not own, and
 * only on an automatic row — a code's offerability is the other route's.
 */
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const promotionKey = String(body.promotionKey ?? "");
    if (typeof body.describable !== "boolean") {
      throw new KnowledgeValidationError("describable must be true or false.");
    }
    const offer = await setOfferDescribable(await getShopId(), promotionKey, body.describable);
    return NextResponse.json({ offer });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

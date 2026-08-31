import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import {
  concernOptions,
  getShopId,
  listRecommendable,
  setProductConcerns,
} from "@/lib/server/recommendations-service";
import { knowledgeErrorResponse, KnowledgeValidationError } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The sellable catalogue, plus the concerns and how many are curated for each. */
export async function GET() {
  try {
    const products = await listRecommendable(await getShopId());
    return NextResponse.json({ products, concerns: concernOptions(products) });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

/**
 * Sets the whole concern list for one product.
 *
 * THE WHOLE LIST, NOT A TOGGLE. A product is curated for a set of concerns, and
 * sending the set means two people editing different concerns cannot each
 * silently drop the other's — the last write is a complete statement rather than
 * a delta applied to whatever was there.
 */
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    if (!Array.isArray(body.concerns)) {
      throw new KnowledgeValidationError("concerns must be an array.");
    }
    const product = await setProductConcerns(
      await getShopId(),
      String(body.productId ?? ""),
      body.concerns as string[]
    );
    return NextResponse.json({ product });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

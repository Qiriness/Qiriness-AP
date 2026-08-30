import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import {
  getShopId,
  listOfferableCodes,
  listPromotionChoices,
  setPromotionOfferable,
} from "@/lib/server/promotions-service";
import { knowledgeErrorResponse, KnowledgeValidationError } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The active code promotions.
 *
 * TWO AUDIENCES, ONE ENDPOINT, separated by `?offerable=true`. The setup screen
 * needs every active code so somebody can decide which may be offered; the reply
 * screen must only ever see the ones already decided. Splitting on a query
 * parameter rather than on two routes keeps the shaping in one place — the
 * filter is applied in the service, so a caller cannot ask for the full list by
 * spelling the parameter wrong.
 */
export async function GET(request: NextRequest) {
  try {
    const shopId = await getShopId();
    if (request.nextUrl.searchParams.get("offerable") === "true") {
      return NextResponse.json({ codes: await listOfferableCodes(shopId) });
    }
    return NextResponse.json({ promotions: await listPromotionChoices(shopId) });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

/**
 * Marks one promotion offerable, or takes it back off.
 *
 * THE ONLY WRITE THIS APP MAKES TO A SHOPIFY-SYNCED TABLE, and it touches the
 * one column the sync does not own. Everything else on `promotions` is
 * overwritten by the next sync, so nothing else here is editable by design.
 */
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const promotionKey = String(body.promotionKey ?? "");
    if (typeof body.offerable !== "boolean") {
      throw new KnowledgeValidationError("offerable must be true or false.");
    }
    const promotion = await setPromotionOfferable(await getShopId(), promotionKey, body.offerable);
    return NextResponse.json({ promotion });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

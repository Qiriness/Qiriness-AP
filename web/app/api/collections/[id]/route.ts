import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import {
  getShopId,
  setCollectionActive,
  setCollectionDetails,
} from "@/lib/server/collections-service";
import { knowledgeErrorResponse, KnowledgeValidationError } from "@/lib/server/knowledge-errors";
import type { CollectionAxis } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Switching a collection on or off, and nothing else.
 *
 * ITS OWN ENDPOINT BECAUSE IT IS ITS OWN DECISION, the same split
 * `/api/policy/rules/[id]` keeps for approval: setting an axis or a note is
 * bookkeeping, where activating a collection is what lets its products reach a
 * customer. Sharing a handler would mean correcting a typo in a note could
 * silently switch a collection back on after somebody had taken it off.
 */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = await request.json().catch(() => ({}));
    if (typeof body.active !== "boolean") {
      throw new KnowledgeValidationError("active must be true or false.");
    }
    const collection = await setCollectionActive(await getShopId(), params.id, body.active);
    return NextResponse.json({ collection });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

/**
 * The axis and the note — what the collection IS, not whether it is used.
 *
 * `PUT` rather than a second `PATCH` so the two writes cannot be confused for
 * one another from the client either. Both fields travel together and both are
 * a complete statement: sending only the note would leave the caller guessing
 * whether the axis was meant to be cleared.
 */
export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = await request.json().catch(() => ({}));
    const axis = body.axis === null || body.axis === undefined ? null : (String(body.axis) as CollectionAxis);
    const note = body.note === null || body.note === undefined ? null : String(body.note);
    const collection = await setCollectionDetails(await getShopId(), params.id, { axis, note });
    return NextResponse.json({ collection });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { deleteRun, getRun, getShopId, saveIdealAnswer } from "@/lib/server/agent-test-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Params {
  params: { id: string };
}

/** One stored run, with its trace — what the history pane opens. */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const shopId = await getShopId();
    const run = await getRun(shopId, params.id);
    return NextResponse.json({ run });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

/**
 * Saves what the operator would have sent instead.
 *
 * THE MEMORY. The same (model text, human text) capture `ticket_draft_edits`
 * makes for real mail, with the difference that a rehearsal's situation can be
 * invented — so an ideal answer can be written for a case no customer has hit
 * yet. Nothing reads these rows; they are the corpus a later phase learns from.
 *
 * An empty body clears it, stamp and all: a timestamp with no text would be half
 * a row, and the check constraint refuses one.
 */
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const body = await request.json().catch(() => ({}));
    const shopId = await getShopId();
    const run = await saveIdealAnswer(
      shopId,
      params.id,
      typeof body.idealBody === "string" ? body.idealBody : null
    );
    return NextResponse.json({ run });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

/** A run is an operator's note; deleting one is theirs to do. */
export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    const shopId = await getShopId();
    await deleteRun(shopId, params.id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

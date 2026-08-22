import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getShopId } from "@/lib/server/knowledge-service";
import { decideOnDraft } from "@/lib/server/tickets-service";
import { knowledgeErrorResponse, KnowledgeValidationError } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: { id: string };
}

/**
 * Records what a person decided about the drafted reply.
 *
 * `approve` and `reject` are decisions about the agent's text; `edit` replaces
 * it, and the replacement is the interesting one — every edit is written to
 * `ticket_draft_edits` beside the model text it corrected, which is the
 * material Phase 7 memory will learn from.
 *
 * IT CANNOT SEND. There is no send path anywhere in this codebase, so the only
 * outcomes here are the three a person can reach by reading: approved, edited,
 * rejected. `sent` exists in the column's constraint and is written by nothing.
 */
const ALLOWED = new Set(["approved", "edited", "rejected"]);

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const body = await request.json().catch(() => ({}));
    const status = typeof body.status === "string" ? body.status : "";

    if (!ALLOWED.has(status)) {
      throw new KnowledgeValidationError(
        `status must be one of ${[...ALLOWED].join(", ")}.`
      );
    }

    const shopId = await getShopId();
    const draft = await decideOnDraft(shopId, params.id, {
      status: status as "approved" | "edited" | "rejected",
      approvedBody: typeof body.approvedBody === "string" ? body.approvedBody : null,
    });
    return NextResponse.json({ draft });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

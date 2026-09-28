import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSession } from "@/lib/server/auth";
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
 * APPROVING MAY SEND, AND NOTHING HERE DOES. With OUTBOUND_SEND_ENABLED on,
 * an approval or an edit queues an outbound action; the worker sends it after
 * checking the case again (agent/src/outbound). This route never calls a mail
 * provider, and `sent` is not a decision it accepts.
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

    const [shopId, session] = await Promise.all([getShopId(), getSession()]);
    const draft = await decideOnDraft(
      shopId,
      params.id,
      {
        status: status as "approved" | "edited" | "rejected",
        approvedBody: typeof body.approvedBody === "string" ? body.approvedBody : null,
      },
      // Who asked for the send: the user's id, never a name or an address.
      session?.sub ?? null
    );
    return NextResponse.json({ draft });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { deleteRule, getShopId, setRuleApproval } from "@/lib/server/policy-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Approval, and nothing else.
 *
 * ITS OWN ENDPOINT BECAUSE IT IS ITS OWN DECISION. Saving a rule is authoring;
 * approving one is what lets it move somebody's mail. Sharing a handler would
 * mean a typo fix could silently re-approve a rule that had been withdrawn.
 */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = await request.json().catch(() => ({}));
    const shopId = await getShopId();
    const approved = body.approved === true;
    const rule = await setRuleApproval(shopId, params.id, approved ? "approved" : "draft");
    return NextResponse.json({ rule });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

/**
 * Removes a rule outright.
 *
 * A HARD DELETE, matching how a knowledge article is deleted. `deleted_at` exists
 * on the table and is what the WORKER filters on; using it here would leave rows
 * an operator deleted visible to nothing and searchable by no one, which is a
 * worse state than gone. Withdrawing a rule without losing it is what unapproving
 * is for.
 */
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const shopId = await getShopId();
    await deleteRule(shopId, params.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

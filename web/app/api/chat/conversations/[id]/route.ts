import { NextResponse } from "next/server";

import { canUseManagementChat } from "../../../../../../scripts/lib/dashboard-auth.mjs";
import { getSession } from "@/lib/server/auth";
import { getConversation } from "@/lib/server/chat-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET — one conversation with every turn and the queries behind each answer.
 * Only its owner may read it: another user's id answers 404, not 403, so ids
 * cannot be probed.
 */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!canUseManagementChat(user.role)) {
    return NextResponse.json({ error: "Your role cannot use the management chat." }, { status: 403 });
  }
  try {
    const conversation = await getConversation(user, params.id);
    if (!conversation) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    return NextResponse.json({ conversation }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load the conversation." },
      { status: 500 }
    );
  }
}

import { NextResponse } from "next/server";

import { canUseManagementChat } from "../../../../../scripts/lib/dashboard-auth.mjs";
import { getSession } from "@/lib/server/auth";
import { listConversations } from "@/lib/server/chat-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET — the signed-in user's own chat conversations, newest first. */
export async function GET() {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!canUseManagementChat(user.role)) {
    return NextResponse.json({ error: "Your role cannot use the management chat." }, { status: 403 });
  }
  try {
    return NextResponse.json(
      { conversations: await listConversations(user) },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load conversations." },
      { status: 500 }
    );
  }
}
